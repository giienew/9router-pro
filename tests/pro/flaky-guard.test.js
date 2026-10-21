// 9Router Pro — Anti-Flaky Guard tests: response classification + config.
// Run via the workspace harness (see token-saver.test.js header).
import assert from "node:assert";
import { detectFlakyResponse, isDegenerateText, resolveAntiFlakyConfig, inspectChatResponse, inspectChatResponseFull } from "../../open-sse/rtk/flakyGuard.js";

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

describe("inspectChatResponse — body probe (content-type is not trusted)", () => {
  const jsonResponse = (obj, type = "text/event-stream") =>
    new Response(JSON.stringify(obj), { headers: { "Content-Type": type } });

  it("flags a degenerate JSON body even when labeled text/event-stream", async () => {
    const res = jsonResponse(chat({ content: "banana.".repeat(16) }, "length"));
    assert.deepEqual(await inspectChatResponse(res), { flaky: true, reason: "degenerate" });
  });

  it("passes a healthy JSON body and an empty body is flagged", async () => {
    assert.equal((await inspectChatResponse(jsonResponse(chat({ content: "A real answer." })))).flaky, false);
    assert.deepEqual(await inspectChatResponse(new Response("")), { flaky: true, reason: "empty" });
  });

  it("flags a fast-closing SSE stream with no content", async () => {
    const sse = 'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\ndata: [DONE]\n\n';
    const res = new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
    assert.deepEqual(await inspectChatResponse(res), { flaky: true, reason: "empty" });
  });

  it("passes a fast-closing SSE stream that carried content", async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"Hello there, a real streamed answer."}}]}\n\ndata: [DONE]\n\n';
    const res = new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
    assert.equal((await inspectChatResponse(res)).flaky, false);
  });

  it("releases a genuinely live stream unjudged", async () => {
    const live = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
        // never closes — a live stream
      },
    });
    const res = new Response(live, { headers: { "Content-Type": "text/event-stream" } });
    assert.equal((await inspectChatResponse(res)).flaky, false);
  });
});

describe("inspectChatResponseFull — document-style requests judged whole", () => {
  const dripJson = (obj, delayMs = 60) => {
    const raw = JSON.stringify(obj);
    const thirds = [raw.slice(0, 40), raw.slice(40, 90), raw.slice(90)];
    return new Response(new ReadableStream({
      async start(controller) {
        for (const part of thirds) {
          controller.enqueue(new TextEncoder().encode(part));
          await new Promise((r) => setTimeout(r, delayMs));
        }
        controller.close();
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
  };

  it("flags a slow-dripped degenerate JSON document (the live dahl case)", async () => {
    const res = dripJson(chat({ content: "banana.".repeat(16) }, "length"));
    assert.deepEqual(await inspectChatResponseFull(res), { flaky: true, reason: "degenerate" });
    // …and the light probe indeed cannot judge this shape:
    const res2 = dripJson(chat({ content: "banana.".repeat(16) }, "length"));
    assert.equal((await inspectChatResponse(res2)).flaky, false);
  });

  it("salvages malformed JSON and still flags the loop", async () => {
    // Raw newline inside the content string + trailing junk: JSON.parse
    // fails, but the loop must still be caught.
    const bad = `{"choices":[{"message":{"role":"assistant","content":"${"banana.".repeat(16)}"},"finish_reason":"length"}]} trailing`;
    assert.deepEqual(await inspectChatResponseFull(new Response(bad)), { flaky: true, reason: "degenerate" });
    const badOk = `{"choices":[{"message":{"role":"assistant","content":"A real\nanswer here."}}]}`;
    assert.equal((await inspectChatResponseFull(new Response(badOk))).flaky, false);
  });

  it("passes a slow-dripped healthy document; over-cap aborts fail-open", async () => {
    assert.equal((await inspectChatResponseFull(dripJson(chat({ content: "A perfectly fine answer." })))).flaky, false);
    const big = new Response(JSON.stringify(chat({ content: "banana.".repeat(16) })));
    assert.equal((await inspectChatResponseFull(big, 10)).flaky, false);
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
