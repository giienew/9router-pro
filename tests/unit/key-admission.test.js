// Shared per-key admission (P1-11): every modality handler enforces rate
// limits + the token budget at entry, and usageHistory carries an
// apiKey+timestamp index so the quota SUM stays fast as history grows.
// Run from tests/:
//   bun x vitest run unit/key-admission.test.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let admission;
let driver;

function fakeRequest(key) {
  return {
    url: "http://x/v1/embeddings",
    headers: new Headers(key ? { authorization: `Bearer ${key}` } : {}),
    json: async () => ({ model: "test/m" }),
  };
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-admission-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  admission = await import("../../src/sse/services/keyAdmission.js");
  driver = await import("@/lib/db/driver.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("key admission", () => {
  it("creates the apiKey+timestamp index on usageHistory", async () => {
    const adapter = await driver.getAdapter();
    const row = adapter.get(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_uh_apikey_ts'`
    );
    expect(row?.name).toBe("idx_uh_apikey_ts");
  });

  it("no key → admitted with nothing to release", async () => {
    expect(await admission.admitKey(fakeRequest(null))).toBeNull();
  });

  it("over-quota key is blocked at admission, under-quota key is admitted", async () => {
    const key = await db.createApiKey("quota-test", "m-quota-test");
    await db.setKeyQuota(key.id, { enabled: true, limit: 100, windowHours: 24 });

    // Seed 60 tokens: under the 100 budget → admitted.
    await db.saveRequestUsage({
      provider: "p", model: "m", apiKey: key.key,
      tokens: { prompt_tokens: 60, completion_tokens: 0 },
      timestamp: new Date(Date.now() - 1000).toISOString(),
    });
    const under = await admission.admitKey(fakeRequest(key.key));
    expect(under?.response).toBeUndefined();
    expect(under?.hasQuota).toBe(true);
    if (under?.release) under.release();

    // Seed 60 more (distinct timestamp, so the dedup does not merge them):
    // 120 total ≥ 100 → blocked.
    await db.saveRequestUsage({
      provider: "p", model: "m", apiKey: key.key,
      tokens: { prompt_tokens: 60, completion_tokens: 0 },
      timestamp: new Date(Date.now() - 2000).toISOString(),
    });
    const over = await admission.admitKey(fakeRequest(key.key));
    expect(over?.response?.status).toBe(429);
  });

  it("a blocked key never reaches the modality handler", async () => {
    const key = await db.createApiKey("blocked-test", "m-blocked-test");
    await db.setKeyQuota(key.id, { enabled: true, limit: 10, windowHours: 24 });
    await db.saveRequestUsage({
      provider: "p", model: "m", apiKey: key.key,
      tokens: { prompt_tokens: 50, completion_tokens: 0 },
      timestamp: new Date().toISOString(),
    });
    const { handleEmbeddings } = await import("../../src/sse/handlers/embeddings.js");
    const res = await handleEmbeddings(fakeRequest(key.key));
    expect(res.status).toBe(429);
  });
});
