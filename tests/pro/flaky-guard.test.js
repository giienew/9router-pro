// 9Router Pro — Anti-Flaky Guard tests: response classification + config.
// Run via the workspace harness (see token-saver.test.js header).
import assert from "node:assert";
import { detectFlakyResponse, isDegenerateText, resolveAntiFlakyConfig } from "../../open-sse/rtk/flakyGuard.js";

const chat = (message, finish = "stop") => ({
  id: "chatcmpl-1", object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }],
});

describe("detectFlakyResponse — empty", () => {
  it("flags empty and whitespace-only content", () => {
    assert.deepEqual(detectFlakyResponse(chat({ content: "" })), { flaky: true, reason: "empty" });
    assert.deepEqual(detectFlakyResponse(chat({ content: "   \n " })), { flaky: true, reason: "empty" });
  });

  it("flags a bodyless response object", () => {
    assert.equal(detectFlakyResponse({}).flaky, true);
    assert.equal(detectFlakyResponse(null).flaky, false); // unparseable → fail open
  });

  it("flags empty Claude and Gemini shapes", () => {
    assert.equal(detectFlakyResponse({ type: "message", content: [{ type: "text", text: "" }] }).flaky, true);
    assert.equal(detectFlakyResponse({ candidates: [{ content: { parts: [{ text: "" }] } }] }).flaky, true);
  });
});

describe("detectFlakyResponse — legitimate answers pass", () => {
  it("normal prose passes", () => {
    assert.equal(detectFlakyResponse(chat({ content: "Here is the summary you asked for, with real content." })).flaky, false);
  });

  it("tool calls with empty text pass", () => {
    const body = chat({ content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] }, "tool_calls");
    assert.equal(detectFlakyResponse(body).flaky, false);
    assert.equal(detectFlakyResponse({ type: "message", content: [{ type: "tool_use", id: "t1", name: "f", input: {} }] }).flaky, false);
  });

  it("reasoning-only answers pass", () => {
    assert.equal(detectFlakyResponse(chat({ content: "", reasoning_content: "thinking it through" })).flaky, false);
  });

  it("short answers are never degenerate", () => {
    assert.equal(detectFlakyResponse(chat({ content: "OK." })).flaky, false);
  });
});

describe("detectFlakyResponse — degenerate loops", () => {
  it("flags the classic OK.OK.OK loop", () => {
    const body = chat({ content: "OK.".repeat(30) }, "length");
    assert.deepEqual(detectFlakyResponse(body), { flaky: true, reason: "degenerate" });
  });

  it("flags single-char and word loops", () => {
    assert.equal(isDegenerateText("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), true);
    assert.equal(isDegenerateText("test ".repeat(12).trim()), true);
    assert.equal(isDegenerateText("The quick brown fox jumps over the lazy dog repeatedly."), false);
  });
});

describe("resolveAntiFlakyConfig", () => {
  it("defaults on, 2 retries", () => {
    assert.deepEqual(resolveAntiFlakyConfig({}), { enabled: true, maxRetries: 2 });
    assert.deepEqual(resolveAntiFlakyConfig(null), { enabled: true, maxRetries: 2 });
  });

  it("honors the toggle and clamps retries", () => {
    assert.deepEqual(resolveAntiFlakyConfig({ antiFlakyEnabled: false }), { enabled: false, maxRetries: 2 });
    assert.equal(resolveAntiFlakyConfig({ antiFlakyMaxRetries: 99 }).maxRetries, 5);
    assert.equal(resolveAntiFlakyConfig({ antiFlakyMaxRetries: -3 }).maxRetries, 0);
    assert.equal(resolveAntiFlakyConfig({ antiFlakyMaxRetries: "x" }).maxRetries, 2);
  });
});
