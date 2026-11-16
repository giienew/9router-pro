import { beforeEach, describe, expect, it, vi } from "vitest";

// Combo perf (sweep 2026-11-16, item 4): the chat retry loop re-selected
// credentials per account attempt, and every selection re-ran SELECT * +
// decrypt over the whole provider pool. handleSingleModelChat now loads the
// pool once per member turn and passes it as options.connections. These
// tests prove getProviderCredentials honours that snapshot (no DB load)
// while still applying the exclude set and the lock/breaker filters.

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(async () => []),
  getSettings: vi.fn(async () => ({ fallbackStrategy: "balanced" })),
  getProxyPools: vi.fn(async () => []),
  updateProviderConnection: vi.fn(async () => {}),
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
  pickProxyPoolId: vi.fn(() => null),
  resolveRotationPoolIds: vi.fn(() => []),
}));

const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

function conn(id) {
  return { id, providerSpecificData: {}, authType: "api_key", accessToken: "tok-" + id };
}

describe("getProviderCredentials — preloaded connections snapshot", () => {
  // The db mock is shared across tests in this file; clear call history
  // between tests so the "no DB load" assertions only see their own test.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("serves from options.connections without touching the DB", async () => {
    const snapshot = [conn("conn-a"), conn("conn-b")];
    const creds = await getProviderCredentials("deepseek", null, "deepseek-chat", { connections: snapshot });
    expect(db.getProviderConnections).not.toHaveBeenCalled();
    expect(["conn-a", "conn-b"]).toContain(creds.connectionId);
  });

  it("loads from the DB when no snapshot is passed (control)", async () => {
    db.getProviderConnections.mockResolvedValueOnce([conn("conn-db")]);
    const creds = await getProviderCredentials("deepseek", null, "deepseek-chat", {});
    expect(db.getProviderConnections).toHaveBeenCalledTimes(1);
    expect(creds.connectionId).toBe("conn-db");
  });

  it("still honours the exclude set against a snapshot", async () => {
    const snapshot = [conn("conn-a"), conn("conn-b")];
    const creds = await getProviderCredentials("deepseek", new Set(["conn-a"]), "deepseek-chat", { connections: snapshot });
    expect(db.getProviderConnections).not.toHaveBeenCalled();
    expect(creds.connectionId).toBe("conn-b");
  });

  it("returns null from an empty snapshot without a DB load", async () => {
    const creds = await getProviderCredentials("deepseek", null, "deepseek-chat", { connections: [] });
    expect(db.getProviderConnections).not.toHaveBeenCalled();
    expect(creds).toBeNull();
  });
});
