// Least-busy routing (9Router Pro): within the clean tier the picker
// prefers the connection with the fewest live requests, penalizes recent
// failures, and spreads bursts synchronously — agent clients hammering a
// multi-key provider (dahl) land on different farmed keys instead of
// piling onto one. Pure-selection tests use a fresh load map; dispatch
// tests drive the real getProviderCredentials with the same mocks as
// sticky-random.test.js.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  leastBusyLoad,
  noteLeastBusyPick,
  noteLeastBusyRelease,
  getLeastBusySnapshot,
  leastBusyScore,
  pickLeastBusy,
  resetLeastBusyLoad,
} from "../../open-sse/services/leastBusy.js";
import {
  LEAST_BUSY_IN_FLIGHT_WEIGHT,
  LEAST_BUSY_RECENT_ERROR_WEIGHT,
  LEAST_BUSY_RECENT_ERROR_WINDOW_MS,
  LEAST_BUSY_IN_FLIGHT_STALE_MS,
  LEAST_BUSY_MAX_ENTRIES,
  LEAST_BUSY_MAX_IN_FLIGHT_PER_KEY,
} from "../../open-sse/config/errorConfig.js";
import { lastUsedOverlay } from "../../open-sse/services/accountFallback.js";

const { store, settingsHolder } = vi.hoisted(() => ({
  store: new Map(),
  settingsHolder: { current: { fallbackStrategy: "least-busy", providerStrategies: {} } },
}));

function makeConn(id, patch = {}) {
  return {
    id,
    provider: "dahl",
    authType: "apikey",
    name: `Key ${id}`,
    email: null,
    priority: 1,
    isActive: true,
    apiKey: `dahl_fake_${id}`,
    providerSpecificData: {},
    lastUsedAt: null,
    consecutiveUseCount: 0,
    testStatus: "active",
    lastError: null,
    errorCode: null,
    lastErrorAt: null,
    backoffLevel: 0,
    ...patch,
  };
}

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async ({ provider, isActive } = {}) =>
    [...store.values()].filter(
      (c) => (!provider || c.provider === provider) && (isActive === undefined || c.isActive === isActive)
    )
  ),
  updateProviderConnection: vi.fn(async (id, patch) => {
    const c = store.get(id);
    if (!c) return null;
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete c[k];
      else c[k] = v;
    }
    return c;
  }),
  getSettings: vi.fn(async () => settingsHolder.current),
  validateApiKey: vi.fn(async () => true),
  getProxyPools: vi.fn(async () => []),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    proxyPoolId: null,
    vercelRelayUrl: "",
    strictProxy: false,
  })),
  pickProxyPoolId: vi.fn(() => null),
  resolveRotationPoolIds: vi.fn(() => []),
}));

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
} from "../../src/sse/services/auth.js";

const MODEL = "deepseek-ai/DeepSeek-V4-Flash-0731";
const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

describe("leastBusyScore / load tracker", () => {
  beforeEach(() => {
    resetLeastBusyLoad();
  });

  it("an unknown key is idle with no recent errors", () => {
    expect(getLeastBusySnapshot("k1", NOW)).toEqual({ inFlight: 0, recentErrors: 0 });
    expect(leastBusyScore({ id: "k1" }, NOW)).toBe(0);
  });

  it("each pick adds one in-flight, weighted above one recent error", () => {
    noteLeastBusyPick("k1", NOW);
    expect(getLeastBusySnapshot("k1", NOW)).toEqual({ inFlight: 1, recentErrors: 0 });
    expect(leastBusyScore({ id: "k1" }, NOW)).toBe(LEAST_BUSY_IN_FLIGHT_WEIGHT);
    expect(LEAST_BUSY_IN_FLIGHT_WEIGHT).toBeGreaterThan(LEAST_BUSY_RECENT_ERROR_WEIGHT);
  });

  it("a release frees one in-flight slot; a failed release also records a recent error", () => {
    noteLeastBusyPick("k1", NOW);
    noteLeastBusyPick("k1", NOW);
    noteLeastBusyRelease("k1", true, NOW);
    expect(getLeastBusySnapshot("k1", NOW)).toEqual({ inFlight: 1, recentErrors: 0 });
    noteLeastBusyRelease("k1", false, NOW);
    expect(getLeastBusySnapshot("k1", NOW)).toEqual({ inFlight: 0, recentErrors: 1 });
    expect(leastBusyScore({ id: "k1" }, NOW)).toBe(LEAST_BUSY_RECENT_ERROR_WEIGHT);
  });

  it("a release never drives in-flight below zero", () => {
    noteLeastBusyRelease("k1", true, NOW);
    expect(getLeastBusySnapshot("k1", NOW)).toEqual({ inFlight: 0, recentErrors: 0 });
    expect(leastBusyLoad.has("k1")).toBe(false);
  });

  it("stale in-flight entries age out lazily with no timer", () => {
    noteLeastBusyPick("k1", NOW);
    expect(getLeastBusySnapshot("k1", NOW + LEAST_BUSY_IN_FLIGHT_STALE_MS - 1).inFlight).toBe(1);
    expect(getLeastBusySnapshot("k1", NOW + LEAST_BUSY_IN_FLIGHT_STALE_MS + 1).inFlight).toBe(0);
  });

  it("recent errors age out of the window", () => {
    noteLeastBusyRelease("k1", false, NOW);
    expect(getLeastBusySnapshot("k1", NOW + LEAST_BUSY_RECENT_ERROR_WINDOW_MS - 1).recentErrors).toBe(1);
    expect(getLeastBusySnapshot("k1", NOW + LEAST_BUSY_RECENT_ERROR_WINDOW_MS + 1).recentErrors).toBe(0);
  });

  it("idle entries with no recent errors are dropped, keeping the map small", () => {
    noteLeastBusyPick("k1", NOW);
    noteLeastBusyRelease("k1", true, NOW);
    expect(leastBusyLoad.has("k1")).toBe(false);
  });

  it("per-key in-flight timestamps are capped", () => {
    for (let i = 0; i < LEAST_BUSY_MAX_IN_FLIGHT_PER_KEY + 10; i++) {
      noteLeastBusyPick("k1", NOW + i);
    }
    expect(getLeastBusySnapshot("k1", NOW + LEAST_BUSY_MAX_IN_FLIGHT_PER_KEY + 10).inFlight)
      .toBe(LEAST_BUSY_MAX_IN_FLIGHT_PER_KEY);
  });

  it("total entries are capped at LEAST_BUSY_MAX_ENTRIES", () => {
    for (let i = 0; i < LEAST_BUSY_MAX_ENTRIES + 50; i++) {
      noteLeastBusyPick(`k${i}`, NOW + i);
    }
    expect(leastBusyLoad.size).toBeLessThanOrEqual(LEAST_BUSY_MAX_ENTRIES);
    resetLeastBusyLoad();
  });
});

describe("pickLeastBusy", () => {
  it("returns null for an empty fleet", () => {
    expect(pickLeastBusy([], NOW, () => 0, new Map())).toBeNull();
    expect(pickLeastBusy(null, NOW, () => 0, new Map())).toBeNull();
  });

  it("prefers the idle key over a busy one", () => {
    const load = new Map();
    const fleet = [{ id: "busy", priority: 1 }, { id: "idle", priority: 1 }];
    noteLeastBusyPick("busy", NOW);
    // noteLeastBusyPick writes the shared map; mirror it into the local map.
    load.set("busy", leastBusyLoad.get("busy"));
    expect(pickLeastBusy(fleet, NOW, () => 0, load).id).toBe("idle");
    resetLeastBusyLoad();
  });

  it("prefers fewer in-flight over more, and an idle key over a recently-failed one", () => {
    const load = new Map();
    const fleet = [
      { id: "two-busy", priority: 1 },
      { id: "one-busy", priority: 1 },
      { id: "idle", priority: 1 },
    ];
    load.set("two-busy", { pickedAt: [NOW, NOW], errors: [], touchedAt: NOW });
    load.set("one-busy", { pickedAt: [NOW], errors: [], touchedAt: NOW });
    expect(pickLeastBusy(fleet, NOW, () => 0, load).id).toBe("idle");

    const failed = [
      { id: "failed", priority: 1 },
      { id: "clean", priority: 1 },
    ];
    const load2 = new Map();
    load2.set("failed", { pickedAt: [], errors: [NOW, NOW, NOW], touchedAt: NOW });
    expect(pickLeastBusy(failed, NOW, () => 0, load2).id).toBe("clean");
  });

  it("one live request outweighs two recent failures", () => {
    const load = new Map();
    const fleet = [
      { id: "busy", priority: 1 },
      { id: "failed-twice", priority: 1 },
    ];
    load.set("busy", { pickedAt: [NOW], errors: [], touchedAt: NOW });
    load.set("failed-twice", { pickedAt: [], errors: [NOW, NOW], touchedAt: NOW });
    // busy scores 1*10=10, failed-twice scores 2*4=8 → failed-twice wins.
    expect(pickLeastBusy(fleet, NOW, () => 0, load).id).toBe("failed-twice");
  });

  it("ties break by least-recently-used, never-used first", () => {
    const load = new Map();
    const fleet = [
      { id: "used-recent", priority: 1, lastUsedAt: iso(NOW - 1000) },
      { id: "never", priority: 1, lastUsedAt: null },
      { id: "used-old", priority: 1, lastUsedAt: iso(NOW - 3600 * 1000) },
    ];
    expect(pickLeastBusy(fleet, NOW, () => 0, load).id).toBe("never");
    const usedOnly = [
      { id: "used-recent", priority: 1, lastUsedAt: iso(NOW - 1000) },
      { id: "used-old", priority: 1, lastUsedAt: iso(NOW - 3600 * 1000) },
    ];
    expect(pickLeastBusy(usedOnly, NOW, () => 0, load).id).toBe("used-old");
  });

  it("exact ties spread randomly instead of pinning one key", () => {
    const load = new Map();
    const fleet = [
      { id: "a", priority: 1, lastUsedAt: null },
      { id: "b", priority: 1, lastUsedAt: null },
    ];
    expect(pickLeastBusy(fleet, NOW, () => 0, load).id).toBe("a");
    expect(pickLeastBusy(fleet, NOW, () => 0.99, load).id).toBe("b");
  });
});

describe("least-busy dispatch via getProviderCredentials", () => {
  beforeEach(() => {
    store.clear();
    resetLeastBusyLoad();
    lastUsedOverlay.clear();
    settingsHolder.current = { fallbackStrategy: "least-busy", providerStrategies: {} };
    store.set("k1", makeConn("k1"));
    store.set("k2", makeConn("k2"));
    store.set("k3", makeConn("k3"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetLeastBusyLoad();
    lastUsedOverlay.clear();
  });

  it("a burst of picks without outcomes spreads across distinct keys", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const first = await getProviderCredentials("dahl", null, MODEL);
    const second = await getProviderCredentials("dahl", null, MODEL);
    const third = await getProviderCredentials("dahl", null, MODEL);
    expect([first.connectionId, second.connectionId, third.connectionId]).toEqual(["k1", "k2", "k3"]);
  });

  it("a successful outcome frees the key, and the next pick rests it in LRU order", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const first = await getProviderCredentials("dahl", null, MODEL);
    expect(first.connectionId).toBe("k1");
    await clearAccountError(first.connectionId, first, MODEL);
    expect(getLeastBusySnapshot("k1").inFlight).toBe(0);
    const second = await getProviderCredentials("dahl", null, MODEL);
    expect(second.connectionId).toBe("k2");
  });

  it("a request-scoped failure (400, no lock) still penalizes the key on the next pick", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const first = await getProviderCredentials("dahl", null, MODEL);
    expect(first.connectionId).toBe("k1");
    const marked = await markAccountUnavailable("k1", 400, "bad request", "dahl", MODEL);
    expect(marked.shouldFallback).toBe(false);
    // No model lock was written, so k1 stays eligible — but its recent
    // error makes it lose to the idle keys.
    expect(store.get("k1")[`modelLock_${MODEL}`]).toBeUndefined();
    const second = await getProviderCredentials("dahl", null, MODEL);
    expect(second.connectionId).toBe("k2");
  });

  it("prefers the clean tier even when a suspect key is idle", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    store.set("k2", makeConn("k2", { backoffLevel: 2, lastError: "boom", lastErrorAt: iso(Date.now() - 60 * 1000) }));
    store.set("k3", makeConn("k3", { backoffLevel: 1, lastError: "boom", lastErrorAt: iso(Date.now() - 60 * 1000) }));
    const first = await getProviderCredentials("dahl", null, MODEL);
    expect(first.connectionId).toBe("k1");
  });

  it("still serves when every key is suspect", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    for (const id of ["k1", "k2", "k3"]) {
      store.set(id, makeConn(id, { backoffLevel: 2, lastError: "boom", lastErrorAt: iso(Date.now() - 60 * 1000) }));
    }
    const first = await getProviderCredentials("dahl", null, MODEL);
    expect(first.connectionId).toBe("k1");
  });

  it("a per-provider override selects least-busy while the global strategy stays balanced", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    settingsHolder.current = {
      fallbackStrategy: "balanced",
      providerStrategies: { dahl: { fallbackStrategy: "least-busy" } },
    };
    // k1 carries two live requests; balanced would ignore that and take
    // the never-used k1, least-busy must take k2 instead.
    noteLeastBusyPick("k1", Date.now());
    noteLeastBusyPick("k1", Date.now());
    const first = await getProviderCredentials("dahl", null, MODEL);
    expect(first.connectionId).toBe("k2");
  });

  it("balanced still ignores in-flight load (control for the override test)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    settingsHolder.current = { fallbackStrategy: "balanced", providerStrategies: {} };
    store.set("k2", makeConn("k2", { lastUsedAt: iso(NOW - 3600 * 1000) }));
    store.set("k3", makeConn("k3", { lastUsedAt: iso(NOW - 7200 * 1000) }));
    noteLeastBusyPick("k1", Date.now());
    noteLeastBusyPick("k1", Date.now());
    const first = await getProviderCredentials("dahl", null, MODEL);
    expect(first.connectionId).toBe("k1");
  });

  it("an unknown strategy still falls through to fill-first (existing behaviour)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    settingsHolder.current = { fallbackStrategy: "bogus-strategy", providerStrategies: {} };
    const first = await getProviderCredentials("dahl", null, MODEL);
    expect(first.connectionId).toBe("k1");
  });
});
