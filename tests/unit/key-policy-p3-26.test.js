// Per-key policy (P3-26): expiry, USD cost caps, and the scoped usage view.
// Run from tests/:
//   bun x vitest run unit/key-policy-p3-26.test.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let quotaRepo;
let keysRepo;
let usageRepo;

const NOW = new Date().toISOString();
const insertUsage = async (apiKey, cost, promptTokens = 10) => {
  const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  adapter.run(
    `INSERT INTO usageHistory(timestamp, provider, model, apiKey, endpoint, promptTokens, completionTokens, cost, status)
     VALUES(?, 'openai', 'gpt-5.4', ?, '/v1/chat/completions', ?, 5, ?, 'ok')`,
    [NOW, apiKey, promptTokens, cost]
  );
};

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-policy-"));
  process.env.DATA_DIR = tempDir;
  db = await import("@/lib/db/index.js");
  await db.initDb();
  quotaRepo = await import("@/lib/db/repos/keyQuotaRepo.js");
  keysRepo = await import("@/lib/db/repos/apiKeysRepo.js");
  usageRepo = await import("@/lib/db/repos/usageRepo.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("cleanQuota costLimit", () => {
  it("keeps a positive costLimit", () => {
    expect(quotaRepo.cleanQuota({ limit: 1000, windowHours: 24, costLimit: 2.5 }))
      .toMatchObject({ limit: 1000, costLimit: 2.5 });
  });
  it("drops non-positive costLimits but keeps the token quota", () => {
    expect(quotaRepo.cleanQuota({ limit: 1000, windowHours: 24, costLimit: 0 }))
      .not.toHaveProperty("costLimit");
    expect(quotaRepo.cleanQuota({ limit: 1000, windowHours: 24, costLimit: -5 }))
      .not.toHaveProperty("costLimit");
  });
  it("a costLimit alone does not create a quota", () => {
    expect(quotaRepo.cleanQuota({ costLimit: 5 })).toBeNull();
  });
});

describe("isKeyExpired", () => {
  it("past dates expire, future/null/garbage do not", () => {
    expect(keysRepo.isKeyExpired("2000-01-01T00:00:00.000Z")).toBe(true);
    expect(keysRepo.isKeyExpired("2999-01-01T00:00:00.000Z")).toBe(false);
    expect(keysRepo.isKeyExpired(null)).toBe(false);
    expect(keysRepo.isKeyExpired("not-a-date")).toBe(false);
  });
});

describe("checkKeyQuota cost branch", () => {
  it("blocks when spend reaches the cost cap, even with token headroom", async () => {
    await quotaRepo.setKeyQuota("k-cost", { enabled: true, limit: 1_000_000, windowHours: 24, costLimit: 1 });
    await insertUsage("raw-cost-key", 0.6);
    await insertUsage("raw-cost-key", 0.6);
    const verdict = await quotaRepo.checkKeyQuota("k-cost", "raw-cost-key");
    expect(verdict.blocked).toBe(true);
    expect(verdict.costBlocked).toBe(true);
    expect(verdict.costUsed).toBeCloseTo(1.2, 9);
  });
  it("does not block below the cost cap", async () => {
    await quotaRepo.setKeyQuota("k-cost-ok", { enabled: true, limit: 1_000_000, windowHours: 24, costLimit: 5 });
    await insertUsage("raw-cost-ok", 0.4);
    const verdict = await quotaRepo.checkKeyQuota("k-cost-ok", "raw-cost-ok");
    expect(verdict.blocked).toBe(false);
    expect(verdict.costUsed).toBeCloseTo(0.4, 9);
  });
});

describe("scoped usage view", () => {
  it("returns only the caller's rows, with totals", async () => {
    await insertUsage("raw-mine", 0.3, 100);
    await insertUsage("raw-mine", 0.7, 200);
    await insertUsage("raw-theirs", 9.9, 999);
    const page = await usageRepo.getKeyUsagePage("raw-mine", { limit: 50, offset: 0 });
    expect(page.totals.count).toBe(2);
    expect(page.totals.promptTokens).toBe(300);
    expect(page.totals.cost).toBeCloseTo(1.0, 9);
    expect(page.rows).toHaveLength(2);
    expect(page.rows.every((r) => !("apiKey" in r))).toBe(true);
  });
  it("an expired key fails validateApiKey", async () => {
    const created = await keysRepo.createApiKey("expiring", "machine-test", {
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    expect(await keysRepo.validateApiKey(created.key)).toBe(false);
    const live = await keysRepo.createApiKey("live", "machine-test", {
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    expect(await keysRepo.validateApiKey(live.key)).toBe(true);
  });
});
