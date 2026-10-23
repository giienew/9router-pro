// Balanced selection (9Router Pro): health tiers keep recently-failed
// accounts in reserve without deleting them, the windowed LRU pick spreads
// load without a deterministic hot spot, and the "unavailable" dashboard
// label is gated on a substantial cooldown so short transients cannot
// brand a healthy key as dead (the misreading that once made ~17.7k live
// dahl keys look like a dead fleet).
import { describe, expect, it } from "vitest";
import {
  connectionHealthTier,
  pickWindowedLru,
  shouldStampUnavailable,
} from "../../open-sse/services/accountFallback.js";
import {
  BALANCED_WINDOW_SIZE,
  UNAVAILABLE_LABEL_MIN_COOLDOWN_MS,
  SUSPECT_PROBATION_MS,
} from "../../open-sse/config/errorConfig.js";

const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

describe("connectionHealthTier", () => {
  it("treats a never-failed account as clean", () => {
    expect(connectionHealthTier({ backoffLevel: 0, lastError: null }, NOW, SUSPECT_PROBATION_MS)).toBe(0);
    expect(connectionHealthTier({}, NOW, SUSPECT_PROBATION_MS)).toBe(0);
  });

  it("treats a recently failed account as suspect", () => {
    const recent = { backoffLevel: 2, lastError: "boom", lastErrorAt: iso(NOW - 5 * 60 * 1000) };
    expect(connectionHealthTier(recent, NOW, SUSPECT_PROBATION_MS)).toBe(1);
    const recentErrorOnly = { lastError: "boom", lastErrorAt: iso(NOW - 60 * 1000) };
    expect(connectionHealthTier(recentErrorOnly, NOW, SUSPECT_PROBATION_MS)).toBe(1);
  });

  it("returns a suspect to clean once its failure ages past probation", () => {
    const stale = { backoffLevel: 3, lastError: "boom", lastErrorAt: iso(NOW - SUSPECT_PROBATION_MS - 1000) };
    expect(connectionHealthTier(stale, NOW, SUSPECT_PROBATION_MS)).toBe(0);
  });

  it("keeps a suspect suspect when probation is disabled", () => {
    const stale = { backoffLevel: 3, lastError: "boom", lastErrorAt: iso(NOW - 24 * 3600 * 1000) };
    expect(connectionHealthTier(stale, NOW, 0)).toBe(1);
  });

  it("treats a missing record as suspect", () => {
    expect(connectionHealthTier(null, NOW, SUSPECT_PROBATION_MS)).toBe(1);
  });
});

describe("pickWindowedLru", () => {
  const fleet = [
    { id: "used-recent", priority: 1, lastUsedAt: iso(NOW - 1000) },
    { id: "never-a", priority: 5, lastUsedAt: null },
    { id: "never-b", priority: 3, lastUsedAt: null },
    { id: "used-old", priority: 2, lastUsedAt: iso(NOW - 3600 * 1000) },
  ];

  it("returns null for an empty fleet", () => {
    expect(pickWindowedLru([], BALANCED_WINDOW_SIZE, () => 0)).toBeNull();
    expect(pickWindowedLru(null, BALANCED_WINDOW_SIZE, () => 0)).toBeNull();
  });

  it("prefers never-used accounts, lowest priority number first", () => {
    expect(pickWindowedLru(fleet, 4, () => 0).id).toBe("never-b");
  });

  it("only picks inside the window", () => {
    const windowIds = new Set(["never-b", "never-a"]);
    for (let i = 0; i < 20; i++) {
      const pick = pickWindowedLru(fleet, 2, () => i / 20);
      expect(windowIds.has(pick.id)).toBe(true);
    }
  });

  it("with a full-size window can reach the least-recently-used end", () => {
    expect(pickWindowedLru(fleet, 4, () => 0.999).id).toBe("used-recent");
  });

  it("works for a single-account fleet", () => {
    expect(pickWindowedLru([{ id: "only" }], BALANCED_WINDOW_SIZE, () => 0.5).id).toBe("only");
  });
});

describe("shouldStampUnavailable", () => {
  it("does not brand an account over a short transient cooldown", () => {
    expect(shouldStampUnavailable(30 * 1000, UNAVAILABLE_LABEL_MIN_COOLDOWN_MS)).toBe(false);
    expect(shouldStampUnavailable(5 * 1000, UNAVAILABLE_LABEL_MIN_COOLDOWN_MS)).toBe(false);
  });

  it("brands an account when the cooldown is substantial", () => {
    expect(shouldStampUnavailable(UNAVAILABLE_LABEL_MIN_COOLDOWN_MS, UNAVAILABLE_LABEL_MIN_COOLDOWN_MS)).toBe(true);
    expect(shouldStampUnavailable(2 * 60 * 1000, UNAVAILABLE_LABEL_MIN_COOLDOWN_MS)).toBe(true);
  });
});
