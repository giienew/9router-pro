// Key-scoped /v1/models cache: TTL expiry, write invalidation, and the
// health-write exception (lock/error writes must NOT thrash the cache).
// Run from tests/:
//   bun x vitest run unit/models-list-cache.test.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let cache;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-models-cache-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  cache = await import("../../src/sse/services/modelsListCache.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("models list cache", () => {
  it("set/get round-trips and invalidate clears", () => {
    cache.setModelsListCache("full", [{ id: "a/b" }]);
    expect(cache.getModelsListCache("full")).toEqual([{ id: "a/b" }]);
    expect(cache.getModelsListCache("key:other")).toBeNull();
    cache.invalidateModelsListCache();
    expect(cache.getModelsListCache("full")).toBeNull();
  });

  it("entries expire after the TTL", () => {
    vi.useFakeTimers();
    try {
      cache.setModelsListCache("full", [{ id: "a/b" }]);
      vi.advanceTimersByTime(59_000);
      expect(cache.getModelsListCache("full")).toEqual([{ id: "a/b" }]);
      vi.advanceTimersByTime(2_000);
      expect(cache.getModelsListCache("full")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("health-only connection updates keep the cache; list-affecting writes clear it", async () => {
    const conn = await db.createProviderConnection({
      provider: "test", authType: "apikey", name: "a", apiKey: "k1",
    });
    cache.setModelsListCache("full", [{ id: "a/b" }]);
    await db.updateProviderConnection(conn.id, { lastError: "boom" });
    expect(cache.getModelsListCache("full")).toEqual([{ id: "a/b" }]);

    await db.updateProviderConnection(conn.id, { isActive: false });
    expect(cache.getModelsListCache("full")).toBeNull();

    cache.setModelsListCache("full", [{ id: "a/b" }]);
    await db.updateProviderConnection(conn.id, {
      providerSpecificData: { enabledModels: ["m1"] },
    });
    expect(cache.getModelsListCache("full")).toBeNull();

    cache.setModelsListCache("full", [{ id: "a/b" }]);
    await db.createCombo({ name: "c1", models: ["test/m1"] });
    expect(cache.getModelsListCache("full")).toBeNull();
  });
});
