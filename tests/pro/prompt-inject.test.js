// 9Router Pro — Prompt Inject tests (vitest, upstream harness).
// Run from tests/: npx vitest run pro/prompt-inject.test.js
import assert from "node:assert";
import { injectSystemPrompt } from "open-sse/rtk/systemInject.js";
import { FORMATS } from "open-sse/translator/formats.js";
import { selectPromptInjects } from "@/lib/db/repos/promptInjectRepo.js";

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

describe("selectPromptInjects — resolver", () => {
  const profiles = [
    { id: "g1", name: "Global", content: "G", position: "prepend", enabled: true },
    { id: "k1", name: "KeyPersona", content: "K", position: "append", enabled: true },
    { id: "m1", name: "ModelPersona", content: "M", position: "append", enabled: true },
    { id: "off", name: "Disabled", content: "X", position: "append", enabled: false },
    { id: "empty", name: "Empty", content: "   ", position: "append", enabled: true },
  ];
  const bindings = {
    global: ["g1", "off", "empty"],
    byKey: { keyA: ["k1"] },
    byModel: { dpsk_un: ["m1", "g1"], "dahl/deepseek-ai/DeepSeek-V4": ["k1"] },
  };

  it("orders global → key → model, skips disabled/empty, dedupes", () => {
    const out = selectPromptInjects(profiles, bindings, {
      apiKeyId: "keyA",
      requestedModel: "dpsk_un",
      resolvedModel: "dahl/deepseek-ai/DeepSeek-V4",
      bareModel: "deepseek-ai/DeepSeek-V4",
    });
    assert.deepEqual(out.map(p => p.id), ["g1", "k1", "m1"]);
    assert.deepEqual(out.map(p => p.position), ["prepend", "append", "append"]);
  });

  it("unknown key gets global only", () => {
    const out = selectPromptInjects(profiles, bindings, { apiKeyId: "nope", requestedModel: "zzz" });
    assert.deepEqual(out.map(p => p.id), ["g1"]);
  });

  it("empty bindings resolve to nothing", () => {
    const out = selectPromptInjects(profiles, { global: [], byKey: {}, byModel: {} }, { apiKeyId: "keyA" });
    assert.deepEqual(out, []);
  });
});
