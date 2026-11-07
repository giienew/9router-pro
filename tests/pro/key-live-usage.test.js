// 9Router Pro — key live usage: GET /api/keys/[id] returns the same live
// limitsUsage snapshot PUT does, so the dashboard "Live:" line can refresh
// while a key's panel is open instead of freezing at page-load values.
// Run: npx vitest run pro/key-live-usage.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";

const fx = vi.hoisted(() => ({
  key: { id: "k1", name: "seller", key: "sk-test-key-1", isActive: true },
  limits: { rpm: 40, tpm: 1000, rph: null, rpd: null, maxConcurrent: 5 },
  tokenUsage: 123,
}));

vi.mock("@/lib/localDb", () => ({
  deleteApiKey: async () => true,
  getApiKeyById: async (id) => (id === fx.key.id ? { ...fx.key } : null),
  getApiKeyByKey: async () => null,
  getApiKeys: async () => [{ ...fx.key }],
  updateApiKey: async (_id, data) => ({ ...fx.key, ...data }),
  getKeyQuota: async () => null,
  setKeyQuota: async (_id, q) => q,
  deleteKeyQuota: async () => {},
  getKeyUsageInWindow: async () => fx.tokenUsage,
  getKeyLimits: async () => fx.limits,
  setKeyLimits: async (_id, l) => l,
  deleteKeyLimits: async () => {},
}));

const { GET } = await import("../../src/app/api/keys/[id]/route.js");
const { admitKeyRequest, getKeyLimitUsage, __resetKeyRateLimiter } = await import("../../src/lib/keyRateLimiter.js");

const get = (id) => GET(new Request(`http://localhost/api/keys/${id}`), { params: Promise.resolve({ id }) });

describe("GET /api/keys/[id] — live limitsUsage", () => {
  beforeEach(() => {
    __resetKeyRateLimiter();
    fx.limits = { rpm: 40, tpm: 1000, rph: null, rpd: null, maxConcurrent: 5 };
    fx.tokenUsage = 123;
  });

  it("returns window counts from admitted requests plus tpm usage", async () => {
    const now = Date.now();
    const release = admitKeyRequest("k1", now);
    admitKeyRequest("k1", now + 500)();
    const res = await get("k1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key.limitsUsage.rpmUsed).toBe(2);
    expect(body.key.limitsUsage.rpdUsed).toBe(2);
    expect(body.key.limitsUsage.inFlight).toBe(1);
    expect(body.key.limitsUsage.tpmUsed).toBe(123);
    release();
    expect(getKeyLimitUsage("k1").inFlight).toBe(0);
  });

  it("tpmUsed is 0 when the key has no tpm limit", async () => {
    fx.limits = { rpm: 40, tpm: null, rph: null, rpd: null, maxConcurrent: null };
    const res = await get("k1");
    const body = await res.json();
    expect(body.key.limitsUsage.tpmUsed).toBe(0);
    expect(body.key.limitsUsage.rpmUsed).toBe(0);
    expect(body.key.limitsUsage.inFlight).toBe(0);
  });

  it("returns zeros (not an error) when the key has no limits at all", async () => {
    fx.limits = null;
    const res = await get("k1");
    const body = await res.json();
    expect(body.key.limitsUsage).toEqual({ rpmUsed: 0, rphUsed: 0, rpdUsed: 0, inFlight: 0, tpmUsed: 0 });
  });

  it("404 for an unknown key", async () => {
    const res = await get("nope");
    expect(res.status).toBe(404);
  });
});
