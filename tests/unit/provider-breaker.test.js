// Provider breaker (P3-27): trip threshold, half-open probing, dashboard snapshot.
// Run from tests/:
//   bun x vitest run unit/provider-breaker.test.js
import { describe, it, expect, beforeEach } from "vitest";
import {
  providerBreakerGate,
  recordProviderFailure,
  recordProviderSuccess,
  getProviderBreakerSnapshot,
  __resetProviderBreakers,
} from "@/sse/services/providerBreaker.js";
import {
  PROVIDER_BREAKER_OPEN_MS,
  PROVIDER_BREAKER_PROBE_MS,
  PROVIDER_BREAKER_WINDOW_MS,
} from "open-sse/config/errorConfig.js";

beforeEach(() => __resetProviderBreakers());

// Old-style call (provider, conn, now) — the overload treats the numeric
// 3rd arg as the timestamp, so existing callers need no change.
const fail = (provider, conn, now) => recordProviderFailure(provider, conn, now);

describe("provider breaker", () => {
  it("stays closed below threshold or below distinct-connection minimum", () => {
    // 5 failures from ONE connection: broad-outage bar (2 connections) not met.
    for (let i = 0; i < 5; i++) fail("dahl", "c1", 1000 + i);
    expect(providerBreakerGate("dahl", 2000)).toBe("allow");
    expect(getProviderBreakerSnapshot(2000).dahl.state).toBe("closed");
  });
  it("trips on 5 failures across 2 connections in the window", () => {
    fail("dahl", "c1", 1000);
    fail("dahl", "c1", 1100);
    fail("dahl", "c2", 1200);
    fail("dahl", "c2", 1300);
    expect(providerBreakerGate("dahl", 1400)).toBe("allow");
    fail("dahl", "c1", 1500);
    expect(providerBreakerGate("dahl", 1600)).toBe("skip");
    expect(getProviderBreakerSnapshot(1600).dahl.state).toBe("open");
  });
  it("ignores failures outside the window", () => {
    fail("dahl", "c1", 1000);
    fail("dahl", "c2", 2000);
    fail("dahl", "c1", 3000);
    fail("dahl", "c2", 4000);
    // Window is 5 min; failures at t=1000..4000 are all inside it, so one
    // more trips — but aged past the window they no longer count.
    fail("dahl", "c1", 1000 + PROVIDER_BREAKER_WINDOW_MS + 5000);
    expect(providerBreakerGate("dahl", 1000 + PROVIDER_BREAKER_WINDOW_MS + 6000)).toBe("allow");
  });
  it("half-opens after OPEN_MS, re-opens on probe failure, closes on success", () => {
    const t0 = 10000;
    for (const [c, t] of [["c1", 0], ["c2", 100], ["c1", 200], ["c2", 300], ["c1", 400]]) {
      fail("dahl", c, t0 + t);
    }
    const trippedAt = t0 + 400; // openedAt = time of the tripping failure
    expect(providerBreakerGate("dahl", t0 + 500)).toBe("skip");
    expect(providerBreakerGate("dahl", trippedAt + PROVIDER_BREAKER_OPEN_MS + 100)).toBe("allow");
    expect(getProviderBreakerSnapshot(trippedAt + PROVIDER_BREAKER_OPEN_MS + 100).dahl.state).toBe("half-open");
    // Probe failure re-opens immediately.
    fail("dahl", "c1", trippedAt + PROVIDER_BREAKER_OPEN_MS + 200);
    expect(providerBreakerGate("dahl", trippedAt + PROVIDER_BREAKER_OPEN_MS + 300)).toBe("skip");
    // Second probe window, then a success closes it.
    const reopenedAt = trippedAt + PROVIDER_BREAKER_OPEN_MS + 200;
    expect(providerBreakerGate("dahl", reopenedAt + PROVIDER_BREAKER_OPEN_MS + 100)).toBe("allow");
    recordProviderSuccess("dahl", reopenedAt + PROVIDER_BREAKER_OPEN_MS + 200);
    expect(providerBreakerGate("dahl", reopenedAt + PROVIDER_BREAKER_OPEN_MS + 300)).toBe("allow");
    expect(getProviderBreakerSnapshot(reopenedAt + PROVIDER_BREAKER_OPEN_MS + 300).dahl).toBeUndefined();
  });
  it("a quiet probe window closes the breaker", () => {
    const t0 = 50000;
    for (const [c, t] of [["c1", 0], ["c2", 100], ["c1", 200], ["c2", 300], ["c1", 400]]) {
      fail("dahl", c, t0 + t);
    }
    const halfOpenAt = t0 + 400 + PROVIDER_BREAKER_OPEN_MS + 100;
    expect(providerBreakerGate("dahl", halfOpenAt)).toBe("allow");
    expect(providerBreakerGate("dahl", halfOpenAt + PROVIDER_BREAKER_PROBE_MS + 100)).toBe("allow");
    expect(getProviderBreakerSnapshot(halfOpenAt + PROVIDER_BREAKER_PROBE_MS + 100).dahl).toBeUndefined();
  });
  it("failures while open do not extend the open window", () => {
    const t0 = 90000;
    for (const [c, t] of [["c1", 0], ["c2", 100], ["c1", 200], ["c2", 300], ["c1", 400]]) {
      fail("dahl", c, t0 + t);
    }
    fail("dahl", "c2", t0 + 5000); // ignored while open
    expect(providerBreakerGate("dahl", t0 + 400 + PROVIDER_BREAKER_OPEN_MS + 100)).toBe("allow");
  });
  it("snapshot never exposes connection ids", () => {
    fail("dahl", "secret-conn-id", 1000);
    const snap = JSON.stringify(getProviderBreakerSnapshot(2000));
    expect(snap).not.toContain("secret-conn-id");
  });
});

describe("per-model cooldowns", () => {
  const failModel = (provider, conn, model, now) => recordProviderFailure(provider, conn, model, now);

  it("one bad model cools down alone — provider stays closed, other models serve", () => {
    // The DeepAI pattern: one model failing deterministically across keys.
    for (const [c, t] of [["c1", 1000], ["c2", 1100], ["c1", 1200], ["c2", 1300], ["c1", 1400]]) {
      failModel("deepai", c, "gemini-4-argon", t);
    }
    expect(providerBreakerGate("deepai", "gemini-4-argon", 1500)).toBe("skip");
    expect(providerBreakerGate("deepai", "llama-3.1-8b-instant", 1500)).toBe("allow");
    expect(providerBreakerGate("deepai", null, 1500)).toBe("allow");
    expect(getProviderBreakerSnapshot(1500).deepai.state).toBe("closed");
    expect(getProviderBreakerSnapshot(1500).deepai.models["gemini-4-argon"].state).toBe("cooldown");
  });

  it("two bad models cool down independently — provider never trips", () => {
    for (const [c, t] of [["c1", 1000], ["c2", 1100], ["c1", 1200], ["c2", 1300], ["c1", 1400]]) {
      failModel("deepai", c, "gemini-4-argon", t);
    }
    for (const [c, t] of [["c3", 2000], ["c4", 2100], ["c3", 2200], ["c4", 2300], ["c3", 2400]]) {
      failModel("deepai", c, "gpt-6-astra", t);
    }
    expect(providerBreakerGate("deepai", "gemini-4-argon", 2500)).toBe("skip");
    expect(providerBreakerGate("deepai", "gpt-6-astra", 2500)).toBe("skip");
    expect(providerBreakerGate("deepai", "tencent-hy3", 2500)).toBe("allow");
    expect(getProviderBreakerSnapshot(2500).deepai.state).toBe("closed");
  });

  it("a broad outage still trips the provider — failures spread thin across models", () => {
    // No single model reaches 5 failures, but the provider bucket does.
    for (const [c, m, t] of [
      ["c1", "model-a", 1000], ["c2", "model-b", 1100], ["c1", "model-c", 1200],
      ["c2", "model-a", 1300], ["c1", "model-b", 1400], ["c2", "model-c", 1500],
    ]) {
      failModel("dahl", c, m, t);
    }
    expect(providerBreakerGate("dahl", "model-a", 1600)).toBe("skip");
    expect(getProviderBreakerSnapshot(1600).dahl.state).toBe("open");
  });

  it("cooldown expires, then a repeat failure escalates the next cooldown", () => {
    const t0 = 10000;
    for (const [c, t] of [["c1", 0], ["c2", 100], ["c1", 200], ["c2", 300], ["c1", 400]]) {
      failModel("deepai", c, "gemini-4-argon", t0 + t);
    }
    const firstCooldownUntil = t0 + 400 + PROVIDER_BREAKER_OPEN_MS;
    expect(providerBreakerGate("deepai", "gemini-4-argon", t0 + 500)).toBe("skip");
    // Expired: servable again, backoff level kept.
    expect(providerBreakerGate("deepai", "gemini-4-argon", firstCooldownUntil + 100)).toBe("allow");
    for (const [c, t] of [["c1", 0], ["c2", 100], ["c1", 200], ["c2", 300], ["c1", 400]]) {
      failModel("deepai", c, "gemini-4-argon", firstCooldownUntil + 200 + t);
    }
    // Second cooldown is 2x the first (120s, not 60s).
    expect(providerBreakerGate("deepai", "gemini-4-argon", firstCooldownUntil + 700)).toBe("skip");
    expect(providerBreakerGate("deepai", "gemini-4-argon", firstCooldownUntil + 200 + 400 + 2 * PROVIDER_BREAKER_OPEN_MS + 100)).toBe("allow");
  });

  it("a success for the model clears its cooldown; another model's success does not", () => {
    const t0 = 50000;
    for (const [c, t] of [["c1", 0], ["c2", 100], ["c1", 200], ["c2", 300], ["c1", 400]]) {
      failModel("deepai", c, "gemini-4-argon", t0 + t);
    }
    expect(providerBreakerGate("deepai", "gemini-4-argon", t0 + 500)).toBe("skip");
    recordProviderSuccess("deepai", "tencent-hy3", t0 + 600);
    expect(providerBreakerGate("deepai", "gemini-4-argon", t0 + 700)).toBe("skip");
    recordProviderSuccess("deepai", "gemini-4-argon", t0 + 800);
    expect(providerBreakerGate("deepai", "gemini-4-argon", t0 + 900)).toBe("allow");
    expect(getProviderBreakerSnapshot(t0 + 900).deepai).toBeUndefined();
  });

  it("provider/model-prefixed and bare model ids key the same model", () => {
    for (const [c, t] of [["c1", 1000], ["c2", 1100], ["c1", 1200], ["c2", 1300], ["c1", 1400]]) {
      failModel("deepai", c, "deepai/gemini-4-argon", t);
    }
    expect(providerBreakerGate("deepai", "gemini-4-argon", 1500)).toBe("skip");
    recordProviderSuccess("deepai", "gemini-4-argon", 1600);
    expect(providerBreakerGate("deepai", "deepai/gemini-4-argon", 1700)).toBe("allow");
  });

  it("snapshot lists model cooldowns without connection ids", () => {
    failModel("deepai", "secret-conn-id", "gemini-4-argon", 1000);
    failModel("deepai", "secret-conn-id", "gemini-4-argon", 1100);
    failModel("deepai", "other-conn", "gemini-4-argon", 1200);
    failModel("deepai", "other-conn", "gemini-4-argon", 1300);
    failModel("deepai", "secret-conn-id", "gemini-4-argon", 1400);
    const snap = JSON.stringify(getProviderBreakerSnapshot(1500));
    expect(snap).not.toContain("secret-conn-id");
    expect(snap).not.toContain("other-conn");
    expect(snap).toContain("gemini-4-argon");
  });
});
