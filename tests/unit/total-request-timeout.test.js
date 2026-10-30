// Total request deadline (P0-1): unlike the stall timer, trickling bytes
// must NOT reset this one. A stream that drips forever still ends with a
// 504 terminal frame once the total budget is spent.
import { describe, expect, it } from "vitest";

import { pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";
import { buildStreamErrorBytes } from "../../open-sse/utils/streamHelpers.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// Minimal stream controller stub that records aborts
function makeController() {
  let connected = true;
  let aborted = false;
  return {
    signal: new AbortController().signal,
    startTime: Date.now(),
    isConnected: () => connected,
    handleComplete: () => { connected = false; },
    handleError: () => { connected = false; },
    handleDisconnect: () => { connected = false; },
    abort: () => { aborted = true; connected = false; },
    wasAborted: () => aborted,
  };
}

async function readAll(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

describe("total request deadline", () => {
  it("aborts a trickling stream even while bytes keep arriving", async () => {
    // Upstream that never ends and keeps trickling bytes every 10ms: the
    // stall timer resets forever, so only the total deadline can stop it.
    let timer = null;
    const upstream = new ReadableStream({
      start(controller) {
        timer = setInterval(() => {
          try { controller.enqueue(new TextEncoder().encode("data: {}\n\n")); } catch { /* closed */ }
        }, 10);
      },
      cancel() { if (timer) clearInterval(timer); },
    });
    const ctrl = makeController();
    let abortMessage = null;
    const out = pipeWithDisconnect(
      { body: upstream },
      new TransformStream(),
      ctrl,
      (msg) => { abortMessage = msg; return buildStreamErrorBytes(504, msg, FORMATS.OPENAI); },
      60_000, // stall: far above the test duration, never fires
      100, // total: fires quickly
    );
    const text = await Promise.race([
      readAll(out),
      new Promise((_, reject) => setTimeout(() => reject(new Error("stream never ended")), 5000)),
    ]).finally(() => { if (timer) clearInterval(timer); });
    expect(ctrl.wasAborted()).toBe(true);
    expect(abortMessage).toBe("total request timeout");
    expect(text).toContain("total request timeout");
  });

  it("does not abort a fast stream within budget", async () => {
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: hi\n\n"));
        controller.close();
      },
    });
    const ctrl = makeController();
    let abortMessage = null;
    const out = pipeWithDisconnect(
      { body: upstream },
      new TransformStream(),
      ctrl,
      (msg) => { abortMessage = msg; return buildStreamErrorBytes(504, msg, FORMATS.OPENAI); },
      60_000,
      60_000,
    );
    const text = await readAll(out);
    expect(ctrl.wasAborted()).toBe(false);
    expect(abortMessage).toBe(null);
    expect(text).toContain("data: hi");
  });
});
