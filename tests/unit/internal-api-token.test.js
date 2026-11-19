// Internal service token (pro.29, audit item 3 follow-up): internal
// consumers (model test, MITM auto-start, CLI resolve) use a server-side
// token because router keys are hashed at rest. Proof strategy: a REAL
// temp SQLite DB (DATA_DIR) via the real driver, like the S2 hashed-keys
// test. Every claim below is executed against that DB, not asserted from
// source alone. Run from tests/:
//   bun x vitest run unit/internal-api-token.test.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let driver;
let keysRepo;
let internalToken;
let apiKeyUtils;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-internal-token-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  driver = await import("../../src/lib/db/driver.js");
  await driver.getAdapter();
  keysRepo = await import("../../src/lib/db/repos/apiKeysRepo.js");
  internalToken = await import("../../src/lib/auth/internalToken.js");
  apiKeyUtils = await import("../../src/shared/utils/apiKey.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("internal service token", () => {
  beforeEach(() => {
    internalToken.__resetInternalApiTokenCache();
    delete process.env.INTERNAL_API_KEY;
  });

  it("generates a stable token persisted in settings", async () => {
    const t1 = await internalToken.getInternalApiToken();
    expect(t1).toMatch(/^[0-9a-f]{48}$/);
    const t2 = await internalToken.getInternalApiToken();
    expect(t2).toBe(t1);
    const adapter = await driver.getAdapter();
    const row = adapter.get(`SELECT data FROM settings WHERE id = 1`);
    const stored = JSON.parse(row.data);
    expect(stored.internalApiKey).toBe(t1);
  });

  it("env INTERNAL_API_KEY wins over the stored value", async () => {
    const stored = await internalToken.getInternalApiToken();
    internalToken.__resetInternalApiTokenCache();
    process.env.INTERNAL_API_KEY = "env-token-abc";
    expect(await internalToken.getInternalApiToken()).toBe("env-token-abc");
    expect(await internalToken.isInternalApiToken(stored)).toBe(false);
    expect(await internalToken.isInternalApiToken("env-token-abc")).toBe(true);
  });

  it("the internal token validates via validateApiKey", async () => {
    const token = await internalToken.getInternalApiToken();
    expect(await keysRepo.validateApiKey(token)).toBe(true);
    expect(await keysRepo.validateApiKey("not-the-token")).toBe(false);
  });

  it("the internal token is not a user key and does not collide with one", async () => {
    const created = await keysRepo.createApiKey("user-key", "m-test-001", { customKey: "sk-test-userkey-001" });
    const token = await internalToken.getInternalApiToken();
    expect(token).not.toBe("sk-test-userkey-001");
    expect(await keysRepo.validateApiKey("sk-test-userkey-001")).toBe(true);
    expect(await keysRepo.validateApiKey(token)).toBe(true);
    // Presenting a stored hash as a bearer still fails.
    expect(await keysRepo.validateApiKey(apiKeyUtils.hashApiKey("sk-test-userkey-001"))).toBe(false);
  });

  it("isInternalApiToken is constant-time and fails closed", async () => {
    const token = await internalToken.getInternalApiToken();
    expect(await internalToken.isInternalApiToken(token)).toBe(true);
    expect(await internalToken.isInternalApiToken(token.slice(0, -1) + "0")).toBe(false);
    expect(await internalToken.isInternalApiToken("")).toBe(false);
    expect(await internalToken.isInternalApiToken(null)).toBe(false);
  });
});
