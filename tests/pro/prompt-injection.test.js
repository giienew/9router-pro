// 9Router Pro — Prompt Injection + injector tests (vitest, upstream harness).
// Run from tests/: npx vitest run pro/prompt-injection.test.js
import assert from "node:assert";
import { injectSystemPrompt, injectChatTurns } from "open-sse/rtk/systemInject.js";
import { FORMATS } from "open-sse/translator/formats.js";
import { selectPromptInjections, cleanPreset } from "@/lib/db/repos/promptInjectRepo.js";

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

  it("is idempotent", () => {
    const body = { messages: [{ role: "system", content: "BASE" }] };
    injectSystemPrompt(body, FORMATS.OPENAI, "X", "append");
    injectSystemPrompt(body, FORMATS.OPENAI, "X", "append");
    assert.equal(body.messages[0].content, "BASE\n\nX");
  });
});

describe("injectChatTurns — messages[]", () => {
  const TURNS = [
    { role: "user", content: "The codename is BANANA-42." },
    { role: "assistant", content: "Noted: BANANA-42." },
  ];

  it("inserts after the leading system message, before the real chat", () => {
    const body = { messages: [
      { role: "system", content: "SYS" },
      { role: "user", content: "What is the codename?" },
    ]};
    injectChatTurns(body, FORMATS.OPENAI, TURNS);
    assert.deepEqual(body.messages.map(m => m.role), ["system", "user", "assistant", "user"]);
    assert.equal(body.messages[1].content, "The codename is BANANA-42.");
    assert.equal(body.messages[3].content, "What is the codename?");
  });

  it("inserts at index 0 when there is no system message (Claude shape)", () => {
    const body = { system: "SYS", messages: [{ role: "user", content: "hi" }] };
    injectChatTurns(body, FORMATS.CLAUDE, TURNS);
    assert.deepEqual(body.messages.map(m => m.role), ["user", "assistant", "user"]);
  });

  it("merges when the block ends with the role the real chat starts with", () => {
    const body = { messages: [{ role: "user", content: "real question" }] };
    injectChatTurns(body, FORMATS.OPENAI, [{ role: "user", content: "priming" }]);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].content, "priming\n\nreal question");
  });

  it("is idempotent", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    injectChatTurns(body, FORMATS.OPENAI, TURNS);
    injectChatTurns(body, FORMATS.OPENAI, TURNS);
    assert.equal(body.messages.length, 3);
  });

  it("drops empty/invalid turns and no-ops on empty input", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    injectChatTurns(body, FORMATS.OPENAI, [{ role: "user", content: "  " }, { role: "system", content: "x" }]);
    assert.equal(body.messages.length, 1);
    injectChatTurns(body, FORMATS.OPENAI, []);
    assert.equal(body.messages.length, 1);
  });
});

describe("injectChatTurns — Gemini contents[]", () => {
  it("maps assistant → model and inserts at the head", () => {
    const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
    injectChatTurns(body, FORMATS.GEMINI, [
      { role: "user", content: "U1" },
      { role: "assistant", content: "A1" },
    ]);
    assert.deepEqual(body.contents.map(c => c.role), ["user", "model", "user"]);
    assert.equal(body.contents[1].parts[0].text, "A1");
  });
});

describe("injectChatTurns — Responses input[]", () => {
  it("inserts message items after system items with typed content", () => {
    const body = { input: [
      { type: "message", role: "system", content: [{ type: "input_text", text: "SYS" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]};
    injectChatTurns(body, FORMATS.OPENAI, [
      { role: "user", content: "U1" },
      { role: "assistant", content: "A1" },
    ]);
    assert.equal(body.input.length, 4);
    assert.equal(body.input[1].content[0].text, "U1");
    assert.equal(body.input[2].content[0].type, "output_text");
  });
});

describe("selectPromptInjections", () => {
  const single = (content, extra = {}) => ({ content, position: "append", enabled: true, ...extra });
  const chat = (turns, extra = {}) => ({ mode: "chat", turns, position: "append", enabled: true, ...extra });

  it("stacks global → user → model, singles carry text", () => {
    const out = selectPromptInjections(
      {
        global: single("G"),
        byKey: { k1: single("U") },
        byModel: { mycombo: single("M") },
      },
      { apiKeyId: "k1", requestedModel: "mycombo" }
    );
    assert.deepEqual(out.map(p => p.text), ["G", "U", "M"]);
    assert.ok(out.every(p => p.mode === "single"));
  });

  it("chat entries carry turns, not text", () => {
    const turns = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }];
    const out = selectPromptInjections(
      { global: chat(turns), byKey: {}, byModel: {} },
      {}
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].mode, "chat");
    assert.deepEqual(out[0].turns, turns);
  });

  it("legacy content-only entries (no mode) resolve as single", () => {
    const out = selectPromptInjections(
      { global: { content: "OLD", enabled: true }, byKey: {}, byModel: {} },
      {}
    );
    assert.equal(out[0].mode, "single");
    assert.equal(out[0].text, "OLD");
  });

  it("skips disabled and empty entries; chat with no valid turns is dropped", () => {
    const out = selectPromptInjections(
      {
        global: single("G", { enabled: false }),
        byKey: { k1: chat([{ role: "user", content: "  " }]) },
        byModel: { m: single("M") },
      },
      { apiKeyId: "k1", requestedModel: "m" }
    );
    assert.deepEqual(out.map(p => p.name), ["m"]);
  });

  it("model match order: requested → resolved → bare, first hit wins", () => {
    const out = selectPromptInjections(
      {
        global: null,
        byKey: {},
        byModel: { "prov/mod": single("RESOLVED"), mod: single("BARE") },
      },
      { requestedModel: "alias", resolvedModel: "prov/mod", bareModel: "mod" }
    );
    assert.equal(out[0].text, "RESOLVED");
  });

  const preset = (name, content, targets, extra = {}) => ({
    id: `id-${name}`,
    name,
    content,
    position: "append",
    enabled: true,
    targets,
    ...extra,
  });

  it("presets fire ahead of their scope's direct entry, scopes in order", () => {
    const out = selectPromptInjections(
      {
        global: single("G"),
        byKey: { k1: single("U") },
        byModel: { mycombo: single("M") },
        presets: [
          preset("PG", "PG", { global: true, keys: [] }),
          preset("PU", "PU", { global: false, keys: ["k1"] }),
        ],
      },
      { apiKeyId: "k1", requestedModel: "mycombo" }
    );
    assert.deepEqual(
      out.map((p) => p.name),
      ["preset:PG", "global", "preset:PU", "user", "mycombo"]
    );
  });

  it("a preset fires at most once, at its earliest matching scope", () => {
    const out = selectPromptInjections(
      {
        global: null,
        byKey: {},
        byModel: {},
        presets: [preset("P", "P", { global: true, models: ["m"], keys: ["k1"] })],
      },
      { apiKeyId: "k1", requestedModel: "m" }
    );
    assert.deepEqual(out.map((p) => p.name), ["preset:P"]);
  });

  it("presets skip when disabled, empty, or not targeted", () => {
    const out = selectPromptInjections(
      {
        global: null,
        byKey: {},
        byModel: {},
        presets: [
          preset("OFF", "OFF", { global: true, keys: [] }, { enabled: false }),
          preset("EMPTY", "  ", { global: true, keys: [] }),
          preset("OTHERKEY", "OTHERKEY", { global: false, keys: ["someone-else"] }),
        ],
      },
      { apiKeyId: "k1", requestedModel: "alias" }
    );
    assert.deepEqual(out.map((p) => p.name), []);
  });

  it("presets are user-scope only: model targets are stripped and never fire", () => {
    const cleaned = cleanPreset({
      id: "x1",
      name: "Legacy",
      mode: "single",
      content: "L",
      position: "prepend",
      enabled: true,
      targets: { global: false, models: ["mod"], keys: [] },
    });
    assert.deepEqual(cleaned.targets, { global: false, keys: [] });

    const out = selectPromptInjections(
      {
        global: null,
        byKey: {},
        byModel: { mod: single("M") },
        presets: [preset("LEGACY", "LEGACY", { global: false, models: ["mod"], keys: [] })],
      },
      { requestedModel: "mod" }
    );
    // Only the direct model entry fires — the preset stays silent.
    assert.deepEqual(out.map((p) => p.name), ["mod"]);
  });
});
