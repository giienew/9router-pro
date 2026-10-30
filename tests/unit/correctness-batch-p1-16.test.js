// P1-16 correctness batch: usage dedup on request id, small-fleet rescue
// waiting for lock expiry, variant-migration fingerprint skip.
// Run from tests/:
//   bun x vitest run unit/correctness-batch-p1-16.test.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let auth;
let inject;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-p1-16-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  auth = await import("../../src/sse/services/auth.js");
  inject = await import("@/lib/db/repos/promptInjectRepo.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("usage dedup on request id", () => {
  const entry = (requestId, ts) => ({
    provider: "dedup-prov", model: "dedup-model",
    tokens: { prompt_tokens: 10, completion_tokens: 5 },
    timestamp: ts, connectionId: "c1", apiKey: "k1", requestId,
  });

  it("two saves with the same request id write one row", async () => {
    const ts = new Date().toISOString();
    await db.saveRequestUsage(entry("req-same", ts));
    await db.saveRequestUsage(entry("req-same", ts));
    const rows = await db.getUsageHistory({ provider: "dedup-prov", model: "dedup-model" });
    expect(rows.length).toBe(1);
  });

  it("two saves with different request ids write two rows even at the same millisecond", async () => {
    const ts = new Date().toISOString();
    await db.saveRequestUsage(entry("req-a", ts));
    await db.saveRequestUsage(entry("req-b", ts));
    const rows = await db.getUsageHistory({ provider: "dedup-prov", model: "dedup-model" });
    // 1 row from the previous test + 2 new ones.
    expect(rows.length).toBe(3);
  });
});

describe("small-fleet rescue waits for lock expiry", () => {
  it("waits out a short lock, then serves the account", async () => {
    const conn = await db.createProviderConnection({
      provider: "dahl", authType: "apiKey", name: "dahl-rescue",
      apiKey: "k-rescue",
    });
    await db.updateProviderConnection(conn.id, {
      "modelLock_probe-model": new Date(Date.now() + 150).toISOString(),
    });
    const t0 = Date.now();
    const picked = await auth.getProviderCredentials("dahl", null, "probe-model");
    const elapsed = Date.now() - t0;
    expect(picked?.connectionId).toBe(conn.id);
    expect(elapsed).toBeGreaterThanOrEqual(120);
  });

  it("does not wait out a lock beyond the rescue gate", async () => {
    const conns = await db.getProviderConnections({ provider: "dahl" });
    const conn = conns[0];
    await db.updateProviderConnection(conn.id, {
      "modelLock_probe-model": new Date(Date.now() + 60_000).toISOString(),
    });
    const t0 = Date.now();
    const picked = await auth.getProviderCredentials("dahl", null, "probe-model");
    const elapsed = Date.now() - t0;
    expect(picked?.allRateLimited).toBe(true);
    expect(elapsed).toBeLessThan(5000);
  });
});

describe("variant migration skips leftovers-only remainders", () => {
  it("second run is a no-op; a new convertible entry re-arms it", async () => {
    await inject.setInjectModelPrompt("bare-name", {
      content: "bare prompt", enabled: true,
    });
    expect(await inject.migrateModelPromptsToVariants()).toBe(0);
    expect(await inject.migrateModelPromptsToVariants()).toBe(0);
    const before = await inject.getInjectVariants();
    await inject.setInjectModelPrompt("prov/model", {
      content: "real prompt", enabled: true,
    });
    expect(await inject.migrateModelPromptsToVariants()).toBe(1);
    const after = await inject.getInjectVariants();
    expect(Object.keys(after).length).toBe(Object.keys(before).length + 1);
    // The unconvertible leftover stays in the model map, never dropped.
    expect(await inject.getInjectModelPrompts()).toHaveProperty("bare-name");
  });
});
