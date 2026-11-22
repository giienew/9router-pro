// Provider-level proxy pool, runtime override (replaces the issue #5 KV
// default, 2026-11-23): a providerStrategies override routes every keyed
// connection at request time — provider-level wins over a per-connection
// pool, a per-connection "__none__" (DIRECT on purpose) is never
// overridden, and rotation (proxyPoolIds + rotateStrategy) now works for
// keyed providers too. Proof: a REAL temp SQLite DB (DATA_DIR) via the
// real driver, real settings, real getProviderCredentials. Run from tests/:
//   bun x vitest run unit/provider-level-proxy-override.test.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let auth;
let connProxy;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-provider-proxy-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  auth = await import("../../src/sse/services/auth.js");
  connProxy = await import("@/lib/network/connectionProxy.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function twoPools(suffix) {
  const a = await db.createProxyPool({ name: `pool-a-${suffix}`, proxyUrl: "http://127.0.0.1:9001", isActive: true });
  const b = await db.createProxyPool({ name: `pool-b-${suffix}`, proxyUrl: "http://127.0.0.1:9002", isActive: true });
  return [a, b];
}

async function keyedConnection(provider, name, poolId) {
  return db.createProviderConnection({
    provider, authType: "apikey", name, apiKey: `k-${name}`,
    ...(poolId !== undefined ? { providerSpecificData: { proxyPoolId: poolId } } : {}),
  });
}

describe("resolveProviderLevelProxyPoolId", () => {
  it("an explicit pool beats a configured rotation", async () => {
    const [a, b] = await twoPools("helper-1");
    const picked = await connProxy.resolveProviderLevelProxyPoolId(
      { proxyPoolId: a.id, rotateStrategy: "round-robin", proxyPoolIds: [a.id, b.id] },
      "helper-provider-1"
    );
    expect(picked).toBe(a.id);
  });

  it("rotation runs when no explicit pool is picked", async () => {
    const [a, b] = await twoPools("helper-2");
    const first = await connProxy.resolveProviderLevelProxyPoolId(
      { rotateStrategy: "round-robin", proxyPoolIds: [a.id, b.id] },
      "helper-provider-2"
    );
    const second = await connProxy.resolveProviderLevelProxyPoolId(
      { rotateStrategy: "round-robin", proxyPoolIds: [a.id, b.id] },
      "helper-provider-2"
    );
    expect([a.id, b.id]).toContain(first);
    expect([a.id, b.id]).toContain(second);
    expect(second).not.toBe(first);
  });

  it("nothing configured means null", async () => {
    expect(await connProxy.resolveProviderLevelProxyPoolId({}, "helper-provider-3")).toBeNull();
    expect(await connProxy.resolveProviderLevelProxyPoolId(null, "helper-provider-3")).toBeNull();
    expect(await connProxy.resolveProviderLevelProxyPoolId({ rotateStrategy: "none" }, "helper-provider-3")).toBeNull();
  });
});

describe("resolveEffectiveProxyPoolId", () => {
  it("provider-level wins over a per-connection pool", async () => {
    const [a] = await twoPools("eff-1");
    expect(await connProxy.resolveEffectiveProxyPoolId(
      { proxyPoolId: a.id }, "eff-provider-1", "pool-9"
    )).toBe(a.id);
  });

  it("an explicit __none__ (DIRECT on purpose) is never overridden", async () => {
    const [a] = await twoPools("eff-2");
    expect(await connProxy.resolveEffectiveProxyPoolId(
      { proxyPoolId: a.id }, "eff-provider-2", "__none__"
    )).toBe("__none__");
  });

  it("per-connection pool is the fallback when nothing is set above", async () => {
    expect(await connProxy.resolveEffectiveProxyPoolId(
      {}, "eff-provider-3", "pool-9"
    )).toBe("pool-9");
    expect(await connProxy.resolveEffectiveProxyPoolId(
      {}, "eff-provider-3", null
    )).toBeNull();
  });
});

describe("keyed provider credentials honour the provider-level pool", () => {
  it("a key with no pool uses the provider-level pool", async () => {
    const [a] = await twoPools("e2e-1");
    await keyedConnection("tokenharbor", "no-pool-1");
    await db.updateSettings({ providerStrategies: { tokenharbor: { proxyPoolId: a.id } } });
    const creds = await auth.getProviderCredentials("tokenharbor");
    expect(creds.providerSpecificData.connectionProxyPoolId).toBe(a.id);
    expect(creds.providerSpecificData.connectionProxyEnabled).toBe(true);
  });

  it("provider-level wins over a per-connection pool", async () => {
    const [a, b] = await twoPools("e2e-2");
    await keyedConnection("tokenharbor-wins", "pinned-1", b.id);
    await db.updateSettings({ providerStrategies: { "tokenharbor-wins": { proxyPoolId: a.id } } });
    const creds = await auth.getProviderCredentials("tokenharbor-wins");
    expect(creds.providerSpecificData.connectionProxyPoolId).toBe(a.id);
  });

  it("an explicit __none__ key stays DIRECT under a provider-level pool", async () => {
    const [a] = await twoPools("e2e-3");
    await keyedConnection("tokenharbor-direct", "direct-1", "__none__");
    await db.updateSettings({ providerStrategies: { "tokenharbor-direct": { proxyPoolId: a.id } } });
    const creds = await auth.getProviderCredentials("tokenharbor-direct");
    expect(creds.providerSpecificData.connectionProxyPoolId).toBeNull();
    expect(creds.providerSpecificData.connectionProxyEnabled).toBe(false);
  });

  it("no provider-level setting keeps the per-connection pool", async () => {
    const [, b] = await twoPools("e2e-4");
    await keyedConnection("tokenharbor-fallback", "fallback-1", b.id);
    await db.updateSettings({ providerStrategies: { "tokenharbor-fallback": {} } });
    const creds = await auth.getProviderCredentials("tokenharbor-fallback");
    expect(creds.providerSpecificData.connectionProxyPoolId).toBe(b.id);
  });

  it("rotation cycles pools across successive requests", async () => {
    const [a, b] = await twoPools("e2e-5");
    await keyedConnection("tokenharbor-rotate", "rot-1");
    await db.updateSettings({ providerStrategies: {
      "tokenharbor-rotate": { rotateStrategy: "round-robin", proxyPoolIds: [a.id, b.id] },
    } });
    const first = await auth.getProviderCredentials("tokenharbor-rotate");
    const second = await auth.getProviderCredentials("tokenharbor-rotate");
    expect([a.id, b.id]).toContain(first.providerSpecificData.connectionProxyPoolId);
    expect([a.id, b.id]).toContain(second.providerSpecificData.connectionProxyPoolId);
    expect(second.providerSpecificData.connectionProxyPoolId)
      .not.toBe(first.providerSpecificData.connectionProxyPoolId);
  });
});
