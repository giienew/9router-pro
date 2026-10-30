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
