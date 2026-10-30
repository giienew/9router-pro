// G10/G11: health tier mapping — the 3-state naming over the 0|1 tier
// function, plus the breaker pre-trip definition used by both the summary
// route and /api/health.
import { describe, it, expect } from "vitest";
import { healthTierName } from "../../src/lib/providerHealthSummary.js";

describe("healthTierName", () => {
  const now = Date.now();
  const old = new Date(now - 2 * 60 * 60 * 1000).toISOString();
  const recent = new Date(now - 10 * 60 * 1000).toISOString();

  it("clean: no failure recorded", () => {
    expect(healthTierName({ backoffLevel: 0, lastError: null }, now)).toBe("clean");
  });
  it("suspect: recent failure", () => {
    expect(healthTierName({ backoffLevel: 1, lastError: "boom", lastErrorAt: recent }, now)).toBe("suspect");
  });
  it("probation: failure aged past the 1h window", () => {
    expect(healthTierName({ backoffLevel: 1, lastError: "boom", lastErrorAt: old }, now)).toBe("probation");
  });
  it("null connection is suspect, never clean", () => {
    expect(healthTierName(null, now)).toBe("suspect");
  });
});

describe("pre-trip definition", () => {
  const preTrip = (b) => b.state === "closed" && (b.failuresInWindow || 0) > 0;
  it("closed with failures is pre-trip; closed clean and open are not", () => {
    expect(preTrip({ state: "closed", failuresInWindow: 3 })).toBe(true);
    expect(preTrip({ state: "closed", failuresInWindow: 0 })).toBe(false);
    expect(preTrip({ state: "open", failuresInWindow: 0 })).toBe(false);
    expect(preTrip({ state: "half-open" })).toBe(false);
  });
});
