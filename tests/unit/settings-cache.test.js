// Short settings cache: one request's repeated reads hit the cache, writes
// invalidate immediately, entries expire after the TTL, and callers mutating
// their settings object can never corrupt the cache for others.
// Run from tests/:
//   bun x vitest run unit/settings-cache.test.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let settingsRepo;
let driver;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-settings-cache-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  settingsRepo = await import("@/lib/db/repos/settingsRepo.js");
  driver = await import("@/lib/db/driver.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("settings cache", () => {
  it("serves repeated reads from cache, expires after TTL, and invalidates on write", async () => {
    await settingsRepo.updateSettings({ fallbackStrategy: "round-robin" });
    expect((await settingsRepo.getSettings()).fallbackStrategy).toBe("round-robin");

    // Direct DB write bypassing updateSettings: within the TTL the cached
    // value still wins (staleness is bounded by the TTL by design).
    const adapter = await driver.getAdapter();
    adapter.run(`UPDATE settings SET data = ? WHERE id = 1`, [JSON.stringify({ fallbackStrategy: "sticky-random" })]);
    expect((await settingsRepo.getSettings()).fallbackStrategy).toBe("round-robin");

    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(3100);
      expect((await settingsRepo.getSettings()).fallbackStrategy).toBe("sticky-random");
    } finally {
      vi.useRealTimers();
    }

    // A write via updateSettings invalidates immediately, no TTL wait.
    await settingsRepo.updateSettings({ fallbackStrategy: "balanced" });
    expect((await settingsRepo.getSettings()).fallbackStrategy).toBe("balanced");
  });

  it("caller mutations never leak into the cache", async () => {
    const first = await settingsRepo.getSettings();
    first.fallbackStrategy = "MUTATED";
    first.providerStrategies = { evil: true };
    const second = await settingsRepo.getSettings();
    expect(second.fallbackStrategy).not.toBe("MUTATED");
    expect(second.providerStrategies).not.toEqual({ evil: true });
  });
});
