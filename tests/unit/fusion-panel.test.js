// Fusion panel behavior: a lone panel answer is reused (not re-fetched),
// and panel timeouts abort the underlying call instead of leaving it running.
// Run from tests/:
//   bun x vitest run unit/fusion-panel.test.js
import assert from "node:assert";
import { handleFusionChat } from "../../open-sse/services/combo.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

function chatJson(text, model) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1700000000,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  };
}

const TUNING = { panelHardTimeoutMs: 5000, stragglerGraceMs: 1000 };

describe("fusion panel", () => {
  it("returns the fetched lone answer without re-calling the model", async () => {
    let calls = 0;
    const handleSingleModel = async (body, m) => {
      calls++;
      if (m === "panel-b") return jsonResponse({ error: { message: "boom" } }, 500);
      return jsonResponse(chatJson("hello from a", "panel-a"));
    };
    const res = await handleFusionChat({
      body: { model: "combo", messages: [{ role: "user", content: "hi" }], stream: false },
      models: ["panel-a", "panel-b"],
      handleSingleModel, log, comboName: "combo", tuning: TUNING,
    });
    assert.equal(calls, 2); // 2 panel calls, no re-call of the winner
    const out = await res.json();
    assert.equal(out.choices[0].message.content, "hello from a");
  });

  it("re-emits the lone answer as SSE when the client asked for a stream", async () => {
    const handleSingleModel = async (body, m) => (
      m === "panel-a"
        ? jsonResponse(chatJson("stream me", "panel-a"))
        : jsonResponse({ error: { message: "x" } }, 500)
    );
    const res = await handleFusionChat({
      body: { model: "combo", messages: [{ role: "user", content: "hi" }], stream: true },
      models: ["panel-a", "panel-b"],
      handleSingleModel, log, comboName: "combo", tuning: TUNING,
    });
    assert.ok((res.headers.get("content-type") || "").includes("text/event-stream"));
    const text = await res.text();
    assert.ok(text.includes("stream me"));
    assert.ok(text.includes("[DONE]"));
  });

  it("aborts panel calls on timeout instead of leaving them running", async () => {
    let abortedCount = 0;
    const handleSingleModel = (body, m, isPanel, signal) => new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => { abortedCount++; reject(new Error("aborted")); });
    });
    const res = await handleFusionChat({
      body: { model: "combo", messages: [{ role: "user", content: "hi" }], stream: false },
      models: ["panel-a", "panel-b"],
      handleSingleModel, log, comboName: "combo",
      tuning: { panelHardTimeoutMs: 50, stragglerGraceMs: 10, minPanel: 2 },
    });
    assert.equal(res.status, 503);
    assert.equal(abortedCount, 2);
  });
});
