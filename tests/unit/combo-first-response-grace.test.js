// First-response grace for combos (rival sweep 2026-11-12): a member that
// stalls past its fetch budget is excluded from the combo until its grace
// expires, then rejoins — instead of burning the full timeout on every
// request ("pending terus"). Single-member and unnamed combos never grace.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleComboChat,
  __resetFirstResponseGrace,
} from "../../open-sse/services/combo.js";

const enc = new TextEncoder();
const quietLog = { info: () => {}, warn: () => {}, debug: () => {} };

function sseOk() {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(`data: {"id":"x","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\n`));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetFirstResponseGrace();
});
afterEach(() => {
  vi.useRealTimers();
  __resetFirstResponseGrace();
});

async function runCombo({ models, calls, comboName = "test-combo", timeoutMs = 100, graceMs = 1000 }) {
  const handleSingleModel = async (body, modelStr, signal) => {
    calls.push(modelStr);
    if (modelStr.startsWith("slow/")) {
      // Hang until the attempt timer aborts us, then report 499 like the
      // real handler does for a timer-aborted attempt.
      await new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      });
      return new Response(JSON.stringify({ error: { message: "Request aborted" } }), {
        status: 499,
        headers: { "Content-Type": "application/json" },
      });
    }
    return sseOk();
  };
  const promise = handleComboChat({
    body: { stream: true, messages: [{ role: "user", content: "hi" }] },
    models,
    handleSingleModel,
    log: quietLog,
    comboName,
    comboStrategy: "fallback",
    firstResponseTimeoutMs: timeoutMs,
    firstResponseGraceMs: graceMs,
  });
  // Drive the attempt timer(s) to completion. Advance only 300ms: the
  // attempt budget is 100ms per slow member, and advancing further would
  // blow past the 1000ms grace window the test is measuring.
  await vi.advanceTimersByTimeAsync(300);
  return promise;
}

describe("combo first-response grace", () => {
  it("a timed-out member is skipped on the next request, then rejoins after grace", async () => {
    const calls = [];
    const models = ["slow/a", "fast/b"];
    const r1 = await runCombo({ models, calls });
    expect(r1.status).toBe(200);
    expect(await r1.text()).toContain("OK");
    expect(calls).toEqual(["slow/a", "fast/b"]);

    // Second request: slow/a is in grace, fast/b serves at once.
    calls.length = 0;
    const r2 = await runCombo({ models, calls });
    expect(r2.status).toBe(200);
    expect(calls).toEqual(["fast/b"]);

    // Past the grace window: slow/a is tried again.
    await vi.advanceTimersByTimeAsync(1100);
    calls.length = 0;
    const r3 = await runCombo({ models, calls });
    expect(r3.status).toBe(200);
    expect(calls).toEqual(["slow/a", "fast/b"]);
  });

  it("a lone member never graces — it is retried on the next request", async () => {
    const calls = [];
    const models = ["slow/a"];
    const r1 = await runCombo({ models, calls });
    expect(r1.status).toBe(504);
    expect(calls).toEqual(["slow/a"]);
    calls.length = 0;
    const r2 = await runCombo({ models, calls });
    expect(r2.status).toBe(504);
    expect(calls).toEqual(["slow/a"]);
  });

  it("all members in grace fails fast with a clear 504, no attempt burned", async () => {
    const calls = [];
    const models = ["slow/a", "slow/b"];
    const r1 = await runCombo({ models, calls });
    expect(r1.status).toBe(504);
    expect(calls).toEqual(["slow/a", "slow/b"]);
    calls.length = 0;
    const r2 = await runCombo({ models, calls });
    expect(r2.status).toBe(504);
    expect(await r2.text()).toContain("first-response grace");
    expect(calls).toEqual([]);
  });

  it("grace disabled (0) keeps the old behavior — slow member retried every time", async () => {
    const calls = [];
    const models = ["slow/a", "fast/b"];
    const r1 = await runCombo({ models, calls, graceMs: 0 });
    expect(r1.status).toBe(200);
    expect(calls).toEqual(["slow/a", "fast/b"]);
    calls.length = 0;
    const r2 = await runCombo({ models, calls, graceMs: 0 });
    expect(r2.status).toBe(200);
    expect(calls).toEqual(["slow/a", "fast/b"]);
  });
});
