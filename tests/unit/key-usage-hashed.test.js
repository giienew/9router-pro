// Per-key usage display attribution (pro.29, audit item 3 follow-up):
// usageHistory.apiKey stores the PLAINTEXT key the client presented, but
// the dashboard passes the STORED value — now a hash for migrated rows.
// getKeyUsageInWindow / getKeyCostInWindow must attribute usage to the
// hashed key too, or the dashboard reads 0. Proof: a REAL temp SQLite DB
// (DATA_DIR) via the real driver. Run from tests/:
//   bun x vitest run unit/key-usage-hashed.test.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let driver;
let quotaRepo;
let apiKeyUtils;

const PLAINTEXT = "sk-test-usage-key-001";
const OTHER = "sk-test-other-key-002";

function seedUsage(apiKey, promptTokens, completionTokens, cost, ts) {
  return driver.getAdapter().then((db) => {
    db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta, requestId) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ts, "dahl", "deepseek", null, apiKey, "/v1/chat/completions", promptTokens, completionTokens, cost, "ok", "{}", "{}", null]
    );
  });
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-usage-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  driver = await import("../../src/lib/db/driver.js");
  await driver.getAdapter();
  quotaRepo = await import("../../src/lib/db/repos/keyQuotaRepo.js");
  apiKeyUtils = await import("../../src/shared/utils/apiKey.js");
  const now = new Date().toISOString();
  await seedUsage(PLAINTEXT, 100, 50, 0.01, now);
  await seedUsage(PLAINTEXT, 200, 100, 0.02, now);
  await seedUsage(OTHER, 1000, 500, 0.5, now);
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("per-key usage attribution for hashed keys", () => {
  it("plaintext key still attributes via the fast path", async () => {
    expect(await quotaRepo.getKeyUsageInWindow(PLAINTEXT, 24)).toBe(450);
    expect(await quotaRepo.getKeyCostInWindow(PLAINTEXT, 24)).toBeCloseTo(0.03, 6);
  });

  it("stored hash attributes the same rows (dashboard display path)", async () => {
    const hashed = apiKeyUtils.hashApiKey(PLAINTEXT);
    expect(apiKeyUtils.isHashedApiKey(hashed)).toBe(true);
    expect(await quotaRepo.getKeyUsageInWindow(hashed, 24)).toBe(450);
    expect(await quotaRepo.getKeyCostInWindow(hashed, 24)).toBeCloseTo(0.03, 6);
  });

  it("a different key's hash attributes only its own rows", async () => {
    const hashedOther = apiKeyUtils.hashApiKey(OTHER);
    expect(await quotaRepo.getKeyUsageInWindow(hashedOther, 24)).toBe(1500);
    expect(await quotaRepo.getKeyUsageInWindow(apiKeyUtils.hashApiKey("sk-test-no-such-key"), 24)).toBe(0);
  });

  it("lifetime mode works for the hash path too", async () => {
    const hashed = apiKeyUtils.hashApiKey(PLAINTEXT);
    expect(await quotaRepo.getKeyUsageInWindow(hashed, 0, null, true)).toBe(450);
  });

  it("empty / null key returns 0", async () => {
    expect(await quotaRepo.getKeyUsageInWindow("", 24)).toBe(0);
    expect(await quotaRepo.getKeyUsageInWindow(null, 24)).toBe(0);
    expect(await quotaRepo.getKeyCostInWindow("", 24)).toBe(0);
  });
});
