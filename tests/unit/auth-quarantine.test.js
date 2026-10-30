// Auto-quarantine (P1-12): N consecutive 401/403s deactivate an account
// with a dashboard-visible reason; success and manual re-enable reset
// the counter; a provider-wide auth burst freezes it instead of emptying
// the fleet on a provider-side outage.
// Run from tests/:
//   bun x vitest run unit/auth-quarantine.test.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let auth;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-quarantine-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  auth = await import("../../src/sse/services/auth.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function freshConn(provider, tag = "") {
  return db.createProviderConnection({
    provider, authType: "apikey", name: `q-${provider}${tag}`, apiKey: `k-${provider}${tag}-${Math.random()}`,
  });
}

async function readConn(id) {
  return db.getProviderConnectionById(id);
}

async function fail(conn, provider, status, times = 1) {
  for (let i = 0; i < times; i++) {
    await auth.markAccountUnavailable(conn.id, status, "invalid key", provider, `${provider}/m`);
  }
}

describe("auth quarantine", () => {
  it("quarantines after 5 consecutive 401s, not before", async () => {
    const conn = await freshConn("qtest1");
    await fail(conn, "qtest1", 401, 4);
    let row = await readConn(conn.id);
    expect(row.isActive).toBe(true);
    expect(row.consecutiveAuthFailures).toBe(4);

    await fail(conn, "qtest1", 401, 1);
    row = await readConn(conn.id);
    expect(row.isActive).toBe(false);
    expect(row.consecutiveAuthFailures).toBe(5);
    expect(row.lastError).toContain("Auto-quarantined");
    expect(row.quarantinedAt).toBeTruthy();
  });

  it("403 counts toward quarantine, 500 does not", async () => {
    const conn = await freshConn("qtest2");
    await fail(conn, "qtest2", 403, 2);
    expect((await readConn(conn.id)).consecutiveAuthFailures).toBe(2);
    await fail(conn, "qtest2", 500, 1);
    expect((await readConn(conn.id)).consecutiveAuthFailures).toBe(2);
  });

  it("a success resets the counter", async () => {
    const conn = await freshConn("qtest3");
    await fail(conn, "qtest3", 401, 2);
    expect((await readConn(conn.id)).consecutiveAuthFailures).toBe(2);
    await auth.clearAccountError(conn.id, await readConn(conn.id), "qtest3/m");
    expect((await readConn(conn.id)).consecutiveAuthFailures).toBe(0);
  });

  it("a provider-wide auth burst freezes the counter", async () => {
    const a = await freshConn("qtest4", "-a");
    await fail(a, "qtest4", 401, 4);
    // Four more distinct accounts of the same provider fail once each:
    // the 5th distinct failure trips the broad-provider guard.
    for (const suffix of ["b", "c", "d", "e"]) {
      const other = await freshConn("qtest4", `-${suffix}`);
      await auth.markAccountUnavailable(other.id, 401, "invalid key", "qtest4", "qtest4/m");
    }
    // A's 5th failure lands during the burst: frozen, not quarantined.
    await fail(a, "qtest4", 401, 1);
    const row = await readConn(a.id);
    expect(row.isActive).toBe(true);
    expect(row.consecutiveAuthFailures).toBe(4);
  });

  it("manual re-enable resets the counter and quarantine fields", async () => {
    const conn = await freshConn("qtest5");
    await fail(conn, "qtest5", 401, 5);
    let row = await readConn(conn.id);
    expect(row.isActive).toBe(false);
    await db.updateProviderConnection(conn.id, { isActive: true });
    row = await readConn(conn.id);
    expect(row.isActive).toBe(true);
    expect(row.consecutiveAuthFailures).toBe(0);
    expect(row.quarantineReason).toBeNull();
    expect(row.quarantinedAt).toBeNull();
  });
});
