// Anthropic cache markers preservation (pro.29 item C).
//
// Agent clients (Hermes, OpenClaw, Claude Code) send long repeat histories
// with client-placed `cache_control` breakpoints, and prompt caching on the
// Claude-compatible upstream is what makes those repeats cheap. The router
// used to delete every client marker on the Claude path and re-anchor its own
// (last assistant / last system / last tool), which moved the cached-prefix
// boundary and threw away the prefix the client had already paid to cache;
// the Claude->OpenAI leg dropped markers before the OpenAI filter could
// preserve them for cache-capable providers (alicode/DashScope), and the
// OpenAI->Claude leg rebuilt blocks without them.
//
// Policy under test: a client marker survives in place (same block, same
// value) on every Claude-format route; the router adds its own anchors only
// where the client sent none and the Anthropic 4-marker budget has room;
// markers are never invented for providers that do not support caching.
import { describe, it, expect } from "vitest";
import {
  anchorClaudeCache,
  prepareClaudeRequest,
} from "../../open-sse/translator/formats/claude.js";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";
import { filterToOpenAIFormat } from "../../open-sse/translator/formats/openai.js";

const CC = { type: "ephemeral" };
const CC_1H = { type: "ephemeral", ttl: "1h" };
const text = (t, extra = {}) => ({ type: "text", text: t, ...extra });
const tool = (name, extra = {}) => ({ name, description: "d", input_schema: {}, ...extra });

function countMarkers(body) {
  let n = 0;
  if (Array.isArray(body.system)) for (const b of body.system) if (b?.cache_control) n++;
  if (Array.isArray(body.tools)) for (const t of body.tools) if (t?.cache_control) n++;
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (Array.isArray(m?.content)) for (const b of m.content) if (b?.cache_control) n++;
      else if (m?.content && typeof m.content === "object" && m.content.cache_control) n++;
    }
  }
  return n;
}

// Agent history: a long stable context in the opening user turn, marked by
// the client, followed by assistant + a fresh question. The marker's whole
// point is that the opening turn is the cached prefix.
const agentHistory = () => ({
  model: "claude-sonnet-5",
  max_tokens: 1024,
  system: [text("You are an agent.")],
  tools: [tool("read_file")],
  messages: [
    { role: "user", content: [text("long repo context…", { cache_control: CC_1H })] },
    { role: "assistant", content: [text("Understood.")] },
    { role: "user", content: [text("Now fix the bug.")] },
  ],
});

describe("prepareClaudeRequest — client markers survive on a Claude-compatible provider", () => {
  it("keeps a client marker on a mid-history user turn in place, with its value", () => {
    const out = prepareClaudeRequest(agentHistory(), "claude");
    expect(out.messages[0].content[0].cache_control).toEqual(CC_1H);
    expect(out.messages[0].content[0].text).toBe("long repo context…");
  });

  it("does not move the client marker onto the last assistant turn", () => {
    const out = prepareClaudeRequest(agentHistory(), "claude");
    // Router anchor may also land on the last assistant (budget allows:
    // system + tool + user marker = 3), but the client's marker must still
    // be on the opening turn — the cached prefix boundary must not move.
    expect(out.messages[0].content[0].cache_control).toEqual(CC_1H);
    expect(out.messages[1].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("keeps a 1h ttl the client set instead of downgrading it to 5m", () => {
    const body = agentHistory();
    body.messages[1].content[0].cache_control = CC_1H;
    const out = prepareClaudeRequest(body, "claude");
    expect(out.messages[1].content[0].cache_control).toEqual(CC_1H);
  });

  it("still adds the router's own anchors when the client sent no markers", () => {
    const body = agentHistory();
    delete body.messages[0].content[0].cache_control;
    const out = prepareClaudeRequest(body, "claude");
    expect(out.system[0].cache_control).toEqual(CC_1H);
    expect(out.tools[0].cache_control).toEqual(CC_1H);
    expect(out.messages[1].content[0].cache_control).toEqual(CC);
  });

  it("never emits more than four markers when the client marked everything", () => {
    const body = agentHistory();
    body.system = [text("a", { cache_control: CC }), text("b", { cache_control: CC })];
    body.tools = body.tools.map((t) => ({ ...t, cache_control: CC }));
    body.messages.forEach((m) => m.content.forEach((b) => { b.cache_control = CC; }));
    const out = prepareClaudeRequest(body, "claude");
    expect(countMarkers(out)).toBeLessThanOrEqual(4);
  });

  it("strips a marker from a thinking block (Anthropic rejects it there)", () => {
    const body = agentHistory();
    body.messages[1].content = [
      { type: "thinking", thinking: "hmm", signature: "sig", cache_control: CC },
      text("Understood."),
    ];
    const out = prepareClaudeRequest(body, "claude");
    const thinking = out.messages[1].content.find((b) => b.type === "thinking");
    if (thinking) expect(thinking.cache_control).toBeUndefined();
    // …while the client's real marker on the opening turn still survives.
    expect(out.messages[0].content[0].cache_control).toEqual(CC_1H);
  });

  it("strips a marker from a deferred tool and keeps the rest", () => {
    const body = agentHistory();
    body.tools = [tool("read_file"), tool("later", { defer_loading: true, cache_control: CC })];
    const out = prepareClaudeRequest(body, "claude");
    expect(out.tools.find((t) => t.defer_loading)?.cache_control).toBeUndefined();
    expect(out.messages[0].content[0].cache_control).toEqual(CC_1H);
  });
});

describe("anchorClaudeCache — passthrough path preserves client markers", () => {
  it("keeps a client marker on a mid-history user turn in place", () => {
    const out = anchorClaudeCache(agentHistory());
    expect(out.messages[0].content[0].cache_control).toEqual(CC_1H);
    expect(countMarkers(out)).toBeLessThanOrEqual(4);
  });

  it("still anchors when the client sent no markers", () => {
    const body = agentHistory();
    delete body.messages[0].content[0].cache_control;
    const out = anchorClaudeCache(body);
    expect(out.messages[1].content[0].cache_control).toEqual(CC);
    expect(out.system[0].cache_control).toEqual(CC_1H);
  });

  it("keeps the client's full marker set within budget instead of replacing it", () => {
    const body = agentHistory();
    body.messages[2].content[0].cache_control = CC;
    const out = anchorClaudeCache(body);
    expect(out.messages[0].content[0].cache_control).toEqual(CC_1H);
    expect(out.messages[2].content[0].cache_control).toEqual(CC);
    expect(countMarkers(out)).toBeLessThanOrEqual(4);
  });
});

describe("claude -> openai leg — markers reach cache-capable providers only", () => {
  const claudeBody = () => ({
    system: [text("Be brief.", { cache_control: CC })],
    messages: [
      { role: "user", content: [text("long context…", { cache_control: CC })] },
      { role: "assistant", content: [text("ok")] },
    ],
  });

  it("preserves markers end-to-end when the provider opts into preserveCacheControl", () => {
    const openai = claudeToOpenAIRequest("m", claudeBody(), false);
    filterToOpenAIFormat(openai, { preserveCacheControl: true });
    const system = openai.messages.find((m) => m.role === "system");
    expect(system.content[0].cache_control).toEqual(CC);
    const user = openai.messages.find((m) => m.role === "user");
    expect(Array.isArray(user.content)).toBe(true);
    expect(user.content[0].cache_control).toEqual(CC);
  });

  it("does not fabricate markers for providers without the opt-in (default strips them)", () => {
    const openai = claudeToOpenAIRequest("m", claudeBody(), false);
    filterToOpenAIFormat(openai, {});
    expect(JSON.stringify(openai)).not.toContain("cache_control");
  });

  it("adds no marker when the client sent none, even with the opt-in", () => {
    const body = claudeBody();
    delete body.system[0].cache_control;
    delete body.messages[0].content[0].cache_control;
    const openai = claudeToOpenAIRequest("m", body, false);
    filterToOpenAIFormat(openai, { preserveCacheControl: true });
    expect(JSON.stringify(openai)).not.toContain("cache_control");
  });
});

describe("openai -> claude leg — markers survive into the Claude-format request", () => {
  it("carries a marker on a user text part through to the Claude provider", () => {
    const claude = openaiToClaudeRequest("claude-sonnet-5", {
      messages: [
        { role: "user", content: [{ type: "text", text: "long context…", cache_control: CC_1H }] },
        { role: "user", content: "next question" },
      ],
    }, false);
    const out = prepareClaudeRequest(claude, "claude");
    const marked = out.messages[0].content.find((b) => b.text === "long context…");
    expect(marked?.cache_control).toEqual(CC_1H);
  });

  it("carries a marker on a tool_result block through to the Claude provider", () => {
    const claude = openaiToClaudeRequest("claude-sonnet-5", {
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents", cache_control: CC }] },
      ],
    }, false);
    const out = prepareClaudeRequest(claude, "claude");
    const result = out.messages[0].content.find((b) => b.type === "tool_result");
    expect(result?.cache_control).toEqual(CC);
  });

  it("does not invent a marker when the OpenAI client sent none", () => {
    const claude = openaiToClaudeRequest("claude-sonnet-5", {
      messages: [{ role: "user", content: "hello" }],
    }, false);
    // openaiToClaudeRequest itself adds the router's system/assistant anchors
    // downstream in prepareClaudeRequest; the leg alone must not add a
    // marker to the client's own message block.
    expect(claude.messages[0].content[0].cache_control).toBeUndefined();
  });
});
