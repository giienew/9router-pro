// 9Router Pro — Soul Prompts + injector tests (vitest, upstream harness).
// Run from tests/: npx vitest run pro/soul-prompts.test.js
import assert from "node:assert";
import { injectSystemPrompt } from "open-sse/rtk/systemInject.js";
import { FORMATS } from "open-sse/translator/formats.js";
import { selectSoulPrompt } from "@/lib/db/repos/soulPromptRepo.js";

describe("injectSystemPrompt — OpenAI chat", () => {
  it("append goes after existing system text", () => {
    const body = { messages: [{ role: "system", content: "BASE" }, { role: "user", content: "hi" }] };
    injectSystemPrompt(body, FORMATS.OPENAI, "APPENDED", "append");
    assert.equal(body.messages[0].content, "BASE\n\nAPPENDED");
  });

  it("prepend goes before existing system text", () => {
    const body = { messages: [{ role: "system", content: "BASE" }] };
    injectSystemPrompt(body, FORMATS.OPENAI, "FRONT", "prepend");
    assert.equal(body.messages[0].content, "FRONT\n\nBASE");
  });

  it("stacks prepends then appends, chatCore grouped order (== sequential)", () => {
    const injects = [
      { name: "G", text: "GLOBAL", position: "prepend" },
      { name: "K", text: "KEYPROMPT", position: "prepend" },
      { name: "M", text: "MODELTAIL", position: "append" },
    ];
    // Grouped — the form chatCore applies now (one pass per position)
    const grouped = { messages: [{ role: "system", content: "BASE" }] };
    const prepends = injects.filter(p => p.position === "prepend" && p.text);
    const appends = injects.filter(p => p.position !== "prepend" && p.text);
    if (prepends.length) injectSystemPrompt(grouped, FORMATS.OPENAI, prepends.map(p => p.text).join("\n\n"), "prepend");
    if (appends.length) injectSystemPrompt(grouped, FORMATS.OPENAI, appends.map(p => p.text).join("\n\n"), "append");
    assert.equal(grouped.messages[0].content, "GLOBAL\n\nKEYPROMPT\n\nBASE\n\nMODELTAIL");
    // Sequential reference (the pre-optimization loop) must match byte-for-byte
    const sequential = { messages: [{ role: "system", content: "BASE" }] };
    for (const p of [...prepends].reverse()) injectSystemPrompt(sequential, FORMATS.OPENAI, p.text, "prepend");
    for (const p of appends) injectSystemPrompt(sequential, FORMATS.OPENAI, p.text, "append");
    assert.equal(grouped.messages[0].content, sequential.messages[0].content);
  });

  it("creates a system message when none exists", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    injectSystemPrompt(body, FORMATS.OPENAI, "NEW", "append");
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[0].content, "NEW");
  });

  it("is idempotent — second run does not duplicate", () => {
    const body = { messages: [{ role: "system", content: "BASE" }] };
    injectSystemPrompt(body, FORMATS.OPENAI, "ONCE", "append");
    injectSystemPrompt(body, FORMATS.OPENAI, "ONCE", "append");
    assert.equal(body.messages[0].content, "BASE\n\nONCE");
  });

  it("array content blocks: append pushes, prepend unshifts", () => {
    const body = { messages: [{ role: "system", content: [{ type: "text", text: "BASE" }] }] };
    injectSystemPrompt(body, FORMATS.OPENAI, "TAIL", "append");
    injectSystemPrompt(body, FORMATS.OPENAI, "HEAD", "prepend");
    assert.deepEqual(body.messages[0].content.map(b => b.text), ["HEAD", "BASE", "TAIL"]);
  });
});

describe("injectSystemPrompt — Claude", () => {
  it("string system append/prepend", () => {
    const body = { system: "BASE", messages: [] };
    injectSystemPrompt(body, FORMATS.CLAUDE, "TAIL", "append");
    injectSystemPrompt(body, FORMATS.CLAUDE, "HEAD", "prepend");
    assert.equal(body.system, "HEAD\n\nBASE\n\nTAIL");
  });

  it("array system: append stays before cache_control block, prepend unshifts", () => {
    const body = { system: [{ type: "text", text: "BASE" }, { type: "text", text: "CACHED", cache_control: { type: "ephemeral" } }], messages: [] };
    injectSystemPrompt(body, FORMATS.CLAUDE, "TAIL", "append");
    assert.deepEqual(body.system.map(b => b.text), ["BASE", "TAIL", "CACHED"]);
    injectSystemPrompt(body, FORMATS.CLAUDE, "HEAD", "prepend");
    assert.deepEqual(body.system.map(b => b.text), ["HEAD", "BASE", "TAIL", "CACHED"]);
  });

  it("creates system when absent", () => {
    const body = { messages: [] };
    injectSystemPrompt(body, FORMATS.CLAUDE, "NEW", "append");
    assert.equal(body.system, "NEW");
  });
});

describe("injectSystemPrompt — Gemini", () => {
  it("systemInstruction parts append/prepend", () => {
    const body = { systemInstruction: { parts: [{ text: "BASE" }] }, contents: [] };
    injectSystemPrompt(body, FORMATS.GEMINI, "TAIL", "append");
    injectSystemPrompt(body, FORMATS.GEMINI, "HEAD", "prepend");
    assert.deepEqual(body.systemInstruction.parts.map(p => p.text), ["HEAD", "BASE", "TAIL"]);
  });

  it("handles the antigravity-wrapped body.request shape", () => {
    const body = { request: { contents: [] } };
    injectSystemPrompt(body, FORMATS.ANTIGRAVITY, "NEW", "append");
    assert.deepEqual(body.request.systemInstruction.parts, [{ text: "NEW" }]);
  });
});

describe("injectSystemPrompt — Responses", () => {
  it("instructions string append/prepend", () => {
    const body = { instructions: "BASE", input: [] };
    injectSystemPrompt(body, FORMATS.OPENAI_RESPONSES, "TAIL", "append");
    injectSystemPrompt(body, FORMATS.OPENAI_RESPONSES, "HEAD", "prepend");
    assert.equal(body.instructions, "HEAD\n\nBASE\n\nTAIL");
  });
});

describe("selectSoulPrompt — resolver (global → user → model)", () => {
  const snap = {
    global: { content: "G", position: "prepend", enabled: true },
    byKey: { keyA: { content: "K", position: "append", enabled: true } },
    byModel: {
      dpsk_un: { content: "M", position: "append", enabled: true },
      "dahl/deepseek-ai/DeepSeek-V4": { content: "RM", position: "append", enabled: true },
      off: { content: "X", position: "append", enabled: false },
      empty: { content: "   ", position: "append", enabled: true },
    },
  };

  it("stacks global → user → model, one per scope", () => {
    const out = selectSoulPrompt(snap, {
      apiKeyId: "keyA",
      requestedModel: "dpsk_un",
      resolvedModel: "dahl/deepseek-ai/DeepSeek-V4",
      bareModel: "deepseek-ai/DeepSeek-V4",
    });
    assert.deepEqual(out.map(p => p.name), ["global", "user", "dpsk_un"]);
    assert.deepEqual(out.map(p => p.text), ["G", "K", "M"]);
  });

  it("model match falls back to the resolved provider/model name", () => {
    const out = selectSoulPrompt(snap, { requestedModel: "unknown-combo", resolvedModel: "dahl/deepseek-ai/DeepSeek-V4" });
    assert.deepEqual(out.map(p => p.text), ["G", "RM"]);
  });

  it("unknown key gets global only; disabled/empty model souls are skipped", () => {
    const out = selectSoulPrompt(snap, { apiKeyId: "nope", requestedModel: "off" });
    assert.deepEqual(out.map(p => p.text), ["G"]);
    const out2 = selectSoulPrompt(snap, { apiKeyId: "nope", requestedModel: "empty" });
    assert.deepEqual(out2.map(p => p.text), ["G"]);
  });

  it("nothing set resolves to nothing", () => {
    assert.deepEqual(selectSoulPrompt({}, {}), []);
    assert.deepEqual(selectSoulPrompt({ global: null, byKey: {}, byModel: {} }, { apiKeyId: "keyA" }), []);
  });
});
