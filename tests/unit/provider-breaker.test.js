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
  it("trips on 50 failures across 10 connections in the window", () => {
    // Provider bar (2026-11-18, second retune): 50 failures / 10
    // connections. A burst of 15 failures / 5 keys STILL tripped the
    // provider under Hermes' load — that is the per-model cooldown's
    // job, not the provider's.
    const conns = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10"];
    for (let i = 0; i < 49; i++) fail("dahl", conns[i % 10], 1000 + i * 100);
    expect(providerBreakerGate("dahl", 6000)).toBe("allow");
    fail("dahl", "c10", 6000);
    expect(providerBreakerGate("dahl", 6100)).toBe("skip");
    expect(getProviderBreakerSnapshot(6100).dahl.state).toBe("open");
  });
  it("stays closed on a burst that used to trip it — 15 failures from 5 connections is not a provider outage", () => {
    // Second retune (2026-11-18): 15 failures / 5 keys in 5 min tripped
    // the provider under Hermes' load and parked all of dahl. That burst
    // must NOT trip the provider anymore — it is the per-model
    // cooldown's job.
    const conns = ["c1", "c2", "c3", "c4", "c5"];
    for (let i = 0; i < 15; i++) fail("dahl", conns[i % 5], 1000 + i * 100);
    expect(providerBreakerGate("dahl", 3000)).toBe("allow");
    expect(getProviderBreakerSnapshot(3000).dahl.state).toBe("closed");
  });
  it("ignores failures outside the window", () => {
    // 49 failures in the window, then one more 5 min later. The first
    // 49 are pruned by the 5-min window, so the provider stays closed;
    // if they were counted, 50 failures would trip it.
    const conns = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10"];
    for (let i = 0; i < 49; i++) fail("dahl", conns[i % 10], 1000 + i * 100);
    fail("dahl", "c1", 1000 + PROVIDER_BREAKER_WINDOW_MS + 5000);
    expect(providerBreakerGate("dahl", 1000 + PROVIDER_BREAKER_WINDOW_MS + 6000)).toBe("allow");
    expect(getProviderBreakerSnapshot(1000 + PROVIDER_BREAKER_WINDOW_MS + 6000).dahl.state).toBe("closed");
  });
  it("half-opens after OPEN_MS, tolerates one probe failure, re-opens on the second, closes on success", () => {
    const t0 = 10000;
    const conns = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10"];
    for (let i = 0; i < 50; i++) fail("dahl", conns[i % 10], t0 + i * 100);
    const trippedAt = t0 + 49 * 100; // openedAt = time of the tripping failure
    expect(providerBreakerGate("dahl", t0 + 5000)).toBe("skip");
    expect(providerBreakerGate("dahl", trippedAt + PROVIDER_BREAKER_OPEN_MS + 100)).toBe("allow");
    expect(getProviderBreakerSnapshot(trippedAt + PROVIDER_BREAKER_OPEN_MS + 100).dahl.state).toBe("half-open");
    // First probe failure is tolerated — still half-open.
    fail("dahl", "c1", trippedAt + PROVIDER_BREAKER_OPEN_MS + 200);
    expect(providerBreakerGate("dahl", trippedAt + PROVIDER_BREAKER_OPEN_MS + 300)).toBe("allow");
    expect(getProviderBreakerSnapshot(trippedAt + PROVIDER_BREAKER_OPEN_MS + 300).dahl.state).toBe("half-open");
    // Second probe failure re-opens.
    fail("dahl", "c2", trippedAt + PROVIDER_BREAKER_OPEN_MS + 400);
    expect(providerBreakerGate("dahl", trippedAt + PROVIDER_BREAKER_OPEN_MS + 500)).toBe("skip");
    // Second probe window, then a success closes it.
    const reopenedAt = trippedAt + PROVIDER_BREAKER_OPEN_MS + 400;
    expect(providerBreakerGate("dahl", reopenedAt + PROVIDER_BREAKER_OPEN_MS + 100)).toBe("allow");
    recordProviderSuccess("dahl", reopenedAt + PROVIDER_BREAKER_OPEN_MS + 200);
    expect(providerBreakerGate("dahl", reopenedAt + PROVIDER_BREAKER_OPEN_MS + 300)).toBe("allow");
    expect(getProviderBreakerSnapshot(reopenedAt + PROVIDER_BREAKER_OPEN_MS + 300).dahl).toBeUndefined();
  });
  it("a quiet probe window closes the breaker", () => {
    const t0 = 50000;
    const conns = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10"];
    for (let i = 0; i < 50; i++) fail("dahl", conns[i % 10], t0 + i * 100);
    const halfOpenAt = t0 + 49 * 100 + PROVIDER_BREAKER_OPEN_MS + 100;
    expect(providerBreakerGate("dahl", halfOpenAt)).toBe("allow");
    expect(providerBreakerGate("dahl", halfOpenAt + PROVIDER_BREAKER_PROBE_MS + 100)).toBe("allow");
    expect(getProviderBreakerSnapshot(halfOpenAt + PROVIDER_BREAKER_PROBE_MS + 100).dahl).toBeUndefined();
  });
  it("failures while open do not extend the open window", () => {
    const t0 = 90000;
    const conns = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10"];
    for (let i = 0; i < 50; i++) fail("dahl", conns[i % 10], t0 + i * 100);
    fail("dahl", "c2", t0 + 5000); // ignored while open
    expect(providerBreakerGate("dahl", t0 + 49 * 100 + PROVIDER_BREAKER_OPEN_MS + 100)).toBe("allow");
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
    // No single model reaches its own 5-failure cooldown, but the
    // provider bucket (50 failures / 10 connections) does.
    const models = ["model-a", "model-b", "model-c", "model-d", "model-e", "model-f", "model-g", "model-h", "model-i", "model-j", "model-k", "model-l", "model-m"];
    const conns = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10"];
    let t = 1000;
    let n = 0;
    for (const m of models) {
      const perModel = m === "model-m" ? 2 : 4; // 12*4 + 2 = 50
      for (let i = 0; i < perModel; i++) {
        failModel("dahl", conns[n % 10], m, t);
        t += 100;
        n++;
      }
    }
    expect(providerBreakerGate("dahl", "model-a", t + 100)).toBe("skip");
    expect(getProviderBreakerSnapshot(t + 100).dahl.state).toBe("open");
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
