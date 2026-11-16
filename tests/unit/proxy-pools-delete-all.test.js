// Guards delete-all proxies: one transaction deletes every proxy pool and
// unpins every bound connection (proxyPoolId -> null, back to DIRECT),
// preserving the rest of providerSpecificData. Mirrors the manual
// 2026-11-11 delete-all (2,100 pools, 29,181 connections unpinned).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-delall-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function seedPools(db, ids) {
  const now = new Date().toISOString();
  for (const id of ids) {
    db.run(
      `INSERT INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, 1, 'unknown', ?, ?, ?)`,
      [id, JSON.stringify({ name: id, proxyUrl: "http://127.0.0.1:8080" }), now, now]
    );
  }
}

function seedConnections(db, rows) {
  const now = new Date().toISOString();
  for (const [id, poolId, extra = {}] of rows) {
    const data = { providerSpecificData: { ...extra, proxyPoolId: poolId } };
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, 'dahl', 'apikey', ?, NULL, 1, 1, ?, ?, ?)`,
      [id, id, JSON.stringify(data), now, now]
    );
  }
}

async function boot() {
  const { getAdapter } = await import("@/lib/db/driver.js");
  const db = await getAdapter();
  const repo = await import("@/lib/db/repos/proxyPoolsRepo.js");
  const conns = await import("@/lib/db/repos/connectionsRepo.js");
  return { db, ...repo, getBoundProxyPoolIds: conns.getBoundProxyPoolIds };
}

describe("deleteAllProxyPools", () => {
  it("deletes every pool and unpins every bound connection, reporting counts", async () => {
    const { db, deleteAllProxyPools, getProxyPools, getBoundProxyPoolIds } = await boot();
    seedPools(db, ["pool-a", "pool-b", "pool-c"]);
    seedConnections(db, [
      ["conn-1", "pool-a"],
      ["conn-2", "pool-a"],
      ["conn-3", "pool-b", { prefix: "oc" }],
      // Dangling binding (pool id no longer exists) is unpinned too.
      ["conn-4", "pool-gone"],
      // Unbound connection is untouched.
      ["conn-5", null],
    ]);

    const result = await deleteAllProxyPools();

    expect(result).toEqual({ deletedPools: 3, unpinnedConnections: 4 });
    expect(await getProxyPools()).toEqual([]);
    expect(await getBoundProxyPoolIds()).toEqual([]);
    const rows = db.all(`SELECT id, data FROM providerConnections ORDER BY id`);
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(JSON.parse(row.data).providerSpecificData.proxyPoolId).toBeNull();
    }
  });

  it("preserves the rest of providerSpecificData on unpinned connections", async () => {
    const { db, deleteAllProxyPools } = await boot();
    seedPools(db, ["pool-b"]);
    seedConnections(db, [["conn-3", "pool-b", { prefix: "oc", enabledModels: ["m1"] }]]);

    await deleteAllProxyPools();

    const row = db.get(`SELECT data FROM providerConnections WHERE id = 'conn-3'`);
    expect(JSON.parse(row.data).providerSpecificData).toEqual({
      prefix: "oc",
      enabledModels: ["m1"],
      proxyPoolId: null,
    });
  });

  it("returns zeros on an empty DB and is a no-op on repeat", async () => {
    const { deleteAllProxyPools, getProxyPools } = await boot();
    expect(await deleteAllProxyPools()).toEqual({ deletedPools: 0, unpinnedConnections: 0 });
    expect(await getProxyPools()).toEqual([]);
    expect(await deleteAllProxyPools()).toEqual({ deletedPools: 0, unpinnedConnections: 0 });
  });

  it("unpins connections even when there are no pools left to delete", async () => {
    const { db, deleteAllProxyPools } = await boot();
    seedConnections(db, [["conn-9", "pool-gone"]]);

    const result = await deleteAllProxyPools();

    expect(result).toEqual({ deletedPools: 0, unpinnedConnections: 1 });
    const row = db.get(`SELECT data FROM providerConnections WHERE id = 'conn-9'`);
    expect(JSON.parse(row.data).providerSpecificData.proxyPoolId).toBeNull();
  });
});
