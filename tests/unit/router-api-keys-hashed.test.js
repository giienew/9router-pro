// Audit item 3 — router API keys hashed at rest + masked on read.
// Run from tests/:
//   bun x vitest run unit/router-api-keys-hashed.test.js
// Proof strategy: a REAL temp SQLite DB (DATA_DIR), seeded with legacy
// PLAINTEXT rows exactly like the live DB holds today (ONWER/Hermes key,
// daffa key, Default Key). Every migration claim below is executed
// against that DB, not asserted from source alone.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let driver;
let keysRepo;
let apiKeyUtils;
let maskUtils;

const LEGACY_CUSTOM = "ONWER-simulated-key-123456";
const LEGACY_GENERATED_MACHINE = "0123456789abcdef";

async function storedRow(id) {
  const adapter = await driver.getAdapter();
  return adapter.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
}

function seedLegacy(id, plaintext, name = "legacy", isActive = 1, expiresAt = null) {
  return driver.getAdapter().then((adapter) => {
    adapter.run(
      `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, expiresAt, accessRestricted, accessAllow) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, plaintext, name, "m-legacy", isActive, new Date().toISOString(), expiresAt, 0, null]
    );
  });
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-keys-hashed-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  // NOTE: do NOT import "@/lib/db/index.js" here — in this shared worktree
  // its import chain is currently broken by a sibling item's in-progress
  // change (proxyPoolsRepo imports ./atRestCrypto.js, which does not exist
  // yet; the pre-existing key-admission test fails identically). The repo
  // under test only needs the driver (which runs migrations incl. the
  // apiKeys table) plus the repo module itself, so import those directly.
  // `db` below is the keys repo: it exports create/validate/get/update.
  driver = await import("../../src/lib/db/driver.js");
  await driver.getAdapter();
  keysRepo = await import("../../src/lib/db/repos/apiKeysRepo.js");
  db = keysRepo;
  apiKeyUtils = await import("../../src/shared/utils/apiKey.js");
  maskUtils = await import("../../src/shared/utils/maskApiKey.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("hash helpers (src/shared/utils/apiKey.js)", () => {
  it("hashes deterministically into sha256:<prefix>:<last4>:<hex>", () => {
    const { hashApiKey, parseHashedApiKey } = apiKeyUtils;
    const h1 = hashApiKey(LEGACY_CUSTOM);
    const h2 = hashApiKey(LEGACY_CUSTOM);
    expect(h1).toBe(h2);
    expect(h1.startsWith("sha256:")).toBe(true);
    const parsed = parseHashedApiKey(h1);
    expect(parsed).not.toBeNull();
    expect(parsed.last4).toBe(LEGACY_CUSTOM.slice(-4));
    expect(parsed.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toContain(LEGACY_CUSTOM);
    expect(hashApiKey("different-key-value-123")).not.toBe(h1);
  });

  it("embeds the standard-key prefix so regenerate keeps it after migration", () => {
    const { generateApiKeyWithMachine, hashApiKey, prefixOfStandardKey } = apiKeyUtils;
    const { key } = generateApiKeyWithMachine("0123456789abcdef", "myapp");
    expect(prefixOfStandardKey(key)).toBe("myapp");
    expect(prefixOfStandardKey(hashApiKey(key))).toBe("myapp");
    expect(prefixOfStandardKey(hashApiKey(LEGACY_CUSTOM))).toBeNull();
  });

  it("verifies with crypto.timingSafeEqual on fixed-length digests", () => {
    const src = readFileSync(new URL("../../src/shared/utils/apiKey.js", import.meta.url), "utf-8");
    expect(src).toContain("timingSafeEqual");
    expect(src).toContain('createHash("sha256")');
    const { hashApiKey, verifyApiKeyHash, isHashedApiKey } = apiKeyUtils;
    const stored = hashApiKey(LEGACY_CUSTOM);
    expect(isHashedApiKey(stored)).toBe(true);
    expect(isHashedApiKey(LEGACY_CUSTOM)).toBe(false);
    expect(verifyApiKeyHash(LEGACY_CUSTOM, stored)).toBe(true);
    expect(verifyApiKeyHash(LEGACY_CUSTOM, LEGACY_CUSTOM)).toBe(true); // legacy plaintext
    expect(verifyApiKeyHash("wrong-key-value-0000", stored)).toBe(false);
    expect(verifyApiKeyHash("wrong-key-value-0000", LEGACY_CUSTOM)).toBe(false);
    // Presenting the stored hash itself as a bearer token must NOT verify.
    expect(verifyApiKeyHash(stored, stored)).toBe(false);
    // Malformed stored values fail closed and never throw.
    expect(verifyApiKeyHash(LEGACY_CUSTOM, "sha256:garbage")).toBe(false);
    expect(verifyApiKeyHash(LEGACY_CUSTOM, "")).toBe(false);
    expect(verifyApiKeyHash("", stored)).toBe(false);
  });
});

describe("masking (src/shared/utils/maskApiKey.js)", () => {
  it("masks legacy plaintext as first8***last4 and hashed as ********last4", () => {
    const { maskApiKey, last4OfApiKey, toMaskedApiKeyRecord } = maskUtils;
    const legacy = "sk-0123456789abcdef-abc123-0123abcd";
    expect(maskApiKey(legacy)).toBe("sk-01234***abcd");
    expect(last4OfApiKey(legacy)).toBe("abcd");
    const stored = apiKeyUtils.hashApiKey(LEGACY_CUSTOM);
    expect(maskApiKey(stored)).toBe(`********${LEGACY_CUSTOM.slice(-4)}`);
    expect(maskApiKey(stored)).not.toContain(apiKeyUtils.parseHashedApiKey(stored).digest);
    expect(last4OfApiKey(stored)).toBe(LEGACY_CUSTOM.slice(-4));
    expect(maskApiKey("short-key")).toBe("s***");
    expect(maskApiKey(null)).toBeNull();
  });

  it("toMaskedApiKeyRecord drops `key` and keeps only keyMasked/last4", () => {
    const { toMaskedApiKeyRecord } = maskUtils;
    const out = toMaskedApiKeyRecord({
      id: "k1", name: "ONWER", key: apiKeyUtils.hashApiKey(LEGACY_CUSTOM),
      isActive: true, quotaUsed: 7,
    });
    expect(out).not.toHaveProperty("key");
    expect(out.keyMasked).toBe(`********${LEGACY_CUSTOM.slice(-4)}`);
    expect(out.last4).toBe(LEGACY_CUSTOM.slice(-4));
    expect(out.name).toBe("ONWER");
    expect(out.quotaUsed).toBe(7);
    const legacyOut = toMaskedApiKeyRecord({ id: "k2", key: LEGACY_CUSTOM });
    expect(legacyOut).not.toHaveProperty("key");
    expect(legacyOut.keyMasked).toContain(LEGACY_CUSTOM.slice(-4));
  });
});

describe("create stores a hash, returns the full value once", () => {
  it("DB row is hashed; the returned object carries the plaintext once; it validates", async () => {
    const created = await db.createApiKey("fresh-hashed", "m-fresh");
    expect(created.key).toMatch(/^sk-/);
    const row = await storedRow(created.id);
    expect(row.key.startsWith("sha256:")).toBe(true);
    expect(row.key).not.toBe(created.key);
    expect(row.key).not.toContain(created.key);
    expect(await db.validateApiKey(created.key)).toBe(true);
    expect(await db.validateApiKey("invalid-key-zzzz")).toBe(false);
    // Presenting the stored hash itself must NOT authenticate.
    expect(await db.validateApiKey(row.key)).toBe(false);
    const found = await db.getApiKeyByKey(created.key);
    expect(found?.id).toBe(created.id);
    expect(await db.getApiKeyByKey("invalid-key-zzzz")).toBeNull();
    expect(await db.getApiKeyByKey(row.key)).toBeNull();
  });

  it("a custom key is hashed the same way and validates", async () => {
    const created = await db.createApiKey("fresh-custom", "m-fresh", {
      customKey: "my-custom-router-key-987654",
    });
    expect(created.key).toBe("my-custom-router-key-987654");
    const row = await storedRow(created.id);
    expect(row.key.startsWith("sha256:")).toBe(true);
    expect(await db.validateApiKey("my-custom-router-key-987654")).toBe(true);
  });
});

describe("legacy plaintext migration — the Hermes/ONWER path", () => {
  it("a legacy plaintext key validates, is hashed in place, and keeps validating", async () => {
    await seedLegacy("legacy-onwer", LEGACY_CUSTOM, "ONWER");
    // Before: exactly like the live DB — plaintext on disk.
    expect((await storedRow("legacy-onwer")).key).toBe(LEGACY_CUSTOM);

    // First request after deploy (Hermes presenting ONWER): must succeed.
    expect(await db.validateApiKey(LEGACY_CUSTOM)).toBe(true);
    // ...and the row is now hashed in place: same id/name, no plaintext.
    const migrated = await storedRow("legacy-onwer");
    expect(migrated.key.startsWith("sha256:")).toBe(true);
    expect(migrated.key).not.toContain(LEGACY_CUSTOM);
    expect(migrated.name).toBe("ONWER");
    expect(migrated.isActive).toBe(1);

    // Every request after: the hash path validates the same key.
    expect(await db.validateApiKey(LEGACY_CUSTOM)).toBe(true);
    expect(await db.validateApiKey(LEGACY_CUSTOM)).toBe(true);
    const found = await db.getApiKeyByKey(LEGACY_CUSTOM);
    expect(found?.id).toBe("legacy-onwer");
    expect(found?.name).toBe("ONWER");
    // The stored hash itself is not a usable credential.
    expect(await db.validateApiKey(migrated.key)).toBe(false);
    expect(await db.getApiKeyByKey(migrated.key)).toBeNull();
  });

  it("a legacy generated-format key migrates the same way (prefix preserved)", async () => {
    const { key } = apiKeyUtils.generateApiKeyWithMachine(LEGACY_GENERATED_MACHINE, "sk");
    await seedLegacy("legacy-gen", key, "Default Key");
    expect(await db.validateApiKey(key)).toBe(true);
    const row = await storedRow("legacy-gen");
    expect(row.key.startsWith("sha256:sk:")).toBe(true);
    expect(apiKeyUtils.prefixOfStandardKey(row.key)).toBe("sk");
    expect(await db.validateApiKey(key)).toBe(true);
  });

  it("getApiKeyByKey also migrates (not only validateApiKey)", async () => {
    await seedLegacy("legacy-lookup", "lookup-legacy-key-abcdef", "daffa");
    const found = await db.getApiKeyByKey("lookup-legacy-key-abcdef");
    expect(found?.id).toBe("legacy-lookup");
    expect((await storedRow("legacy-lookup")).key.startsWith("sha256:")).toBe(true);
    expect(await db.validateApiKey("lookup-legacy-key-abcdef")).toBe(true);
  });

  it("inactive and expired legacy keys still fail validation", async () => {
    await seedLegacy("legacy-off", "inactive-legacy-key-1234", "off", 0);
    expect(await db.validateApiKey("inactive-legacy-key-1234")).toBe(false);
    await seedLegacy("legacy-exp", "expired-legacy-key-1234", "exp", 1, "2000-01-01T00:00:00.000Z");
    expect(await db.validateApiKey("expired-legacy-key-1234")).toBe(false);
  });
});

describe("update hashes a replacement value; the old value dies", () => {
  it("updateApiKey with a new plaintext key stores only its hash", async () => {
    const created = await db.createApiKey("rotating", "m-rot");
    expect(await db.validateApiKey(created.key)).toBe(true);
    const updated = await db.updateApiKey(created.id, { key: "replacement-custom-key-777" });
    expect(updated).not.toBeNull();
    const row = await storedRow(created.id);
    expect(row.key.startsWith("sha256:")).toBe(true);
    expect(await db.validateApiKey("replacement-custom-key-777")).toBe(true);
    expect(await db.validateApiKey(created.key)).toBe(false);
  });
});

describe("route responses (source guarantees — the routes need Next.js)", () => {
  it("GET list returns masked records only; POST 201 returns the full value once", () => {
    const src = readFileSync(new URL("../../src/app/api/keys/route.js", import.meta.url), "utf-8");
    expect(src).toContain("toMaskedApiKeyRecord");
    expect(src).toContain("keys: keys.map(toMaskedApiKeyRecord)");
    expect(src).not.toContain("NextResponse.json({ keys })");
    expect(src).toContain("key: apiKey.key");
    expect(src).toContain("keyMasked: maskApiKey(apiKey.key)");
    expect(src).toContain("status: 201");
  });

  it("GET detail returns masked records only; PUT discloses a new value once", () => {
    const src = readFileSync(new URL("../../src/app/api/keys/[id]/route.js", import.meta.url), "utf-8");
    expect(src).toContain("toMaskedApiKeyRecord");
    expect(src).toContain("NextResponse.json({ key: toMaskedApiKeyRecord(key) })");
    // PUT one-time disclosure (pro.29 follow-up): the masked record is the
    // base; when the PUT changed the value, the new plaintext is added as
    // `key` on that masked record only — never the stored hash, never the
    // full record. A read-only PUT carries no full value.
    expect(src).toContain("const masked = toMaskedApiKeyRecord(updated);");
    expect(src).toContain("if (newPlaintext) masked.key = newPlaintext;");
    expect(src).toContain("return NextResponse.json({ key: masked });");
    expect(src).not.toContain("NextResponse.json({ key: updated })");
    // The plaintext source is the in-memory updateData.key, captured
    // BEFORE updateApiKey hashes it on write.
    expect(src).toContain("const newPlaintext = typeof updateData.key === \"string\" && updateData.key !== \"\" ? updateData.key : null;");
  });
});
