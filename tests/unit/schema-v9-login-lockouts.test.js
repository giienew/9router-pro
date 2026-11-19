// SCHEMA_VERSION 8→9 coherence (pro.29 integration item 6): the
// loginLockouts table was added by S4 via the TABLES definition in
// schema.js (SCHEMA_VERSION 9) with NO migration 004 file. The claim to
// prove: an existing v8 DB (no loginLockouts table) gets it on the next
// boot via the additive sync in migrate.js, not via a versioned migration.
// Proof: a REAL temp SQLite DB (DATA_DIR) via the real driver — drop the
// table (simulating v8), re-run runMigrationOnce (simulating the next
// boot), and confirm the table is back with the right columns.
// Run from tests/:
//   bun x vitest run unit/schema-v9-login-lockouts.test.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let driver;
let migrate;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-schema-v9-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  driver = await import("../../src/lib/db/driver.js");
  await driver.getAdapter();
  migrate = await import("../../src/lib/db/migrate.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("SCHEMA_VERSION 9 — loginLockouts additive sync", () => {
  it("fresh boot creates loginLockouts with the declared columns", async () => {
    const db = await driver.getAdapter();
    const cols = db.all(`PRAGMA table_info(loginLockouts)`).map((r) => r.name);
    expect(cols).toEqual(["ip", "fails", "lockUntil", "lockLevel", "lastFailAt"]);
  });

  it("a v8 DB (table dropped) regains loginLockouts on the next boot sync", async () => {
    const db = await driver.getAdapter();
    db.exec(`DROP TABLE loginLockouts`);
    expect(db.all(`PRAGMA table_info(loginLockouts)`)).toEqual([]);
    // Simulate the next boot (PM2 restart = a fresh process, hence a fresh
    // adapter object): runMigrationOnce dedupes per adapter via the
    // _migratedAdapters WeakSet, so a NEW adapter object to the same DB
    // file runs the full migration + additive sync and recreates the table.
    const { createNodeSqliteAdapter } = await import("../../src/lib/db/adapters/nodeSqliteAdapter.js");
    const { DATA_FILE } = await import("../../src/lib/db/paths.js");
    const freshAdapter = await createNodeSqliteAdapter(DATA_FILE);
    try {
      await migrate.runMigrationOnce(freshAdapter);
      const cols = freshAdapter.all(`PRAGMA table_info(loginLockouts)`).map((r) => r.name);
      expect(cols).toEqual(["ip", "fails", "lockUntil", "lockLevel", "lastFailAt"]);
      // And the table is usable (the login limiter's INSERT works).
      freshAdapter.run(`INSERT INTO loginLockouts(ip, fails, lockUntil, lockLevel, lastFailAt) VALUES(?, ?, ?, ?, ?)`, ["1.2.3.4", 3, 0, 0, Date.now()]);
      const row = freshAdapter.get(`SELECT fails FROM loginLockouts WHERE ip = ?`, ["1.2.3.4"]);
      expect(row.fails).toBe(3);
    } finally {
      try { freshAdapter.close?.(); } catch {}
    }
  });

  it("SCHEMA_VERSION is 9 and no migration 004 file is required", async () => {
    const schema = await import("../../src/lib/db/schema.js");
    expect(schema.SCHEMA_VERSION).toBe(9);
    expect(schema.TABLES.loginLockouts).toBeDefined();
    const migrations = await import("../../src/lib/db/migrations/index.js");
    const names = (migrations.MIGRATIONS || []).map((m) => m.name || m.id || "");
    expect(names.join(",")).not.toContain("004");
  });
});
