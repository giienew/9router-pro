import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { store } = vi.hoisted(() => ({ store: new Map() }));

function makeConn(id) {
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
  getSettings: vi.fn(async () => ({ fallbackStrategy: "sticky-random", providerStrategies: {} })),
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
  resetStickyCurrent,
} from "../../src/sse/services/auth.js";

const MODEL = "deepseek-ai/DeepSeek-V4-Flash-0731";
const OTHER_MODEL = "zai-org/GLM-5.3-Flash";

describe("sticky-random routing", () => {
  beforeEach(() => {
    store.clear();
    resetStickyCurrent();
    store.set("k1", makeConn("k1"));
    store.set("k2", makeConn("k2"));
    store.set("k3", makeConn("k3"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sticks to the first picked key while it succeeds", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const first = await getProviderCredentials("dahl", null, MODEL);
    const second = await getProviderCredentials("dahl", null, MODEL);
    const third = await getProviderCredentials("dahl", null, MODEL);
    expect(first.connectionId).toBe("k1");
    expect(second.connectionId).toBe("k1");
    expect(third.connectionId).toBe("k1");
    expect(store.get("k1").consecutiveUseCount).toBe(3);
  });

  it("re-rolls randomly after the current key locks, then sticks to the new key", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const first = await getProviderCredentials("dahl", null, MODEL);
    expect(first.connectionId).toBe("k1");
    const locked = await markAccountUnavailable("k1", 429, "rate limited", "dahl", MODEL);
    expect(locked.shouldFallback).toBe(true);
    // Re-roll: force the random pick to the last available key (k3).
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const second = await getProviderCredentials("dahl", null, MODEL);
    expect(second.connectionId).toBe("k3");
    // Stick: even a roll that would pick k2 must keep k3.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const third = await getProviderCredentials("dahl", null, MODEL);
    expect(third.connectionId).toBe("k3");
  });

  it("keeps stickiness for a model whose key did not lock", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const first = await getProviderCredentials("dahl", null, MODEL);
    expect(first.connectionId).toBe("k1");
    await markAccountUnavailable("k1", 429, "rate limited", "dahl", OTHER_MODEL);
    const second = await getProviderCredentials("dahl", null, MODEL);
    expect(second.connectionId).toBe("k1");
  });

  it("cold-starts with a random pick", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const first = await getProviderCredentials("dahl", null, MODEL);
    expect(first.connectionId).toBe("k2");
  });
});
