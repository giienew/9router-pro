// OpenCode free-lane 429 classification (rival sweep 2026-11-12, upstream
// 0.5.119 + XRouter): quota 429s are never retried, overloaded 429s retry
// with exponential backoff (800ms base, doubling, capped 4000ms, 8 attempts).
import { describe, it, expect } from "vitest";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import opencode from "../../open-sse/providers/registry/opencode.js";

function res(status, headers = {}, body = null) {
  return {
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    clone: () => ({ text: async () => (body == null ? "" : JSON.stringify(body)) }),
  };
}

describe("opencode computeRetryDelay hook (overload classification)", () => {
  const oc = new OpenCodeExecutor();

  it("registry gives 429 eight attempts at 800ms base", () => {
    expect(opencode.transport.retry["429"]).toEqual({ attempts: 8, delayMs: 800 });
  });

  it("vetoes quota 429s (resets_at present) — never retried", async () => {
    const r = res(429, {}, { error: { message: "FreeUsageLimitError", resets_at: Math.floor(Date.now() / 1000) + 3600 } });
    expect(await oc.computeRetryDelay(r, 1, 800)).toBe(false);
  });

  it("vetoes quota 429s (resets_in_seconds present)", async () => {
    const r = res(429, {}, { error: { message: "FreeUsageLimitError", resets_in_seconds: 1800 } });
    expect(await oc.computeRetryDelay(r, 1, 800)).toBe(false);
  });

  it("vetoes quota 429s (retry-after header present)", async () => {
    const r = res(429, { "retry-after": "120" }, { error: { message: "FreeUsageLimitError" } });
    expect(await oc.computeRetryDelay(r, 1, 800)).toBe(false);
  });

  it("retries overloaded 429s with 800 → 1600 → 3200 → 4000ms backoff", async () => {
    const overloaded = () => res(429, {}, { error: { message: "The model is overloaded, please try again" } });
    expect(await oc.computeRetryDelay(overloaded(), 1, 800)).toBe(800);
    expect(await oc.computeRetryDelay(overloaded(), 2, 800)).toBe(1600);
    expect(await oc.computeRetryDelay(overloaded(), 3, 800)).toBe(3200);
    expect(await oc.computeRetryDelay(overloaded(), 4, 800)).toBe(4000);
    expect(await oc.computeRetryDelay(overloaded(), 8, 800)).toBe(4000);
  });

  it("vetoes unknown 429s (no overload signal, no reset) — current behavior", async () => {
    const r = res(429, {}, { error: { message: "Too many requests" } });
    expect(await oc.computeRetryDelay(r, 1, 800)).toBe(false);
  });

  it("defers non-429 statuses to the configured delay (null)", async () => {
    const r = res(503, {}, { error: { message: "Service unavailable" } });
    expect(await oc.computeRetryDelay(r, 1, 2000)).toBeNull();
  });

  it("an overloaded message WITH a reset time is still a quota 429 — vetoed", async () => {
    const r = res(429, {}, { error: { message: "overloaded", resets_in_seconds: 60 } });
    expect(await oc.computeRetryDelay(r, 1, 800)).toBe(false);
  });
});
