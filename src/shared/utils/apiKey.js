import crypto from "crypto";

const API_KEY_SECRET = process.env.API_KEY_SECRET || "endpoint-proxy-api-key-secret";

/**
 * Generate the random keyId segment of an API key: 24 bytes from the
 * cryptographic RNG, hex-encoded (48 chars, ~192 bits). Math.random must
 * never feed key material — its output is predictable and the keyId is the
 * only per-key secret in the {prefix}-{machineId}-{keyId}-{crc8} format
 * (the CRC is a deterministic HMAC of machineId+keyId).
 */
function generateKeyId() {
  return crypto.randomBytes(24).toString("hex");
}

/**
 * Generate CRC (8-char HMAC)
 */
function generateCrc(machineId, keyId) {
  return crypto
    .createHmac("sha256", API_KEY_SECRET)
    .update(machineId + keyId)
    .digest("hex")
    .slice(0, 8);
}

/**
 * Generate API key with machineId embedded
 * Format: {prefix}-{machineId}-{keyId}-{crc8} (default prefix "sk")
 * The CRC is computed over machineId+keyId only, so it is prefix-independent.
 * @param {string} machineId - 16-char machine ID
 * @param {string} [prefix="sk"] - key prefix (letters, digits, - _; max 20 chars)
 * @returns {{ key: string, keyId: string }}
 */
export function generateApiKeyWithMachine(machineId, prefix = "sk") {
  const keyId = generateKeyId();
  const crc = generateCrc(machineId, keyId);
  const safePrefix = typeof prefix === "string" && /^[A-Za-z0-9_-]{1,20}$/.test(prefix) ? prefix : "sk";
  const key = `${safePrefix}-${machineId}-${keyId}-${crc}`;
  return { key, keyId };
}

/**
 * Validate a user-chosen custom key value (used verbatim, no generation).
 * Rules: trimmed, no spaces, only letters/digits/-/_ , 12-128 chars.
 * @param {string} value
 * @returns {{ ok: boolean, value?: string, error?: string }}
 */
export function validateCustomKey(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return { ok: false, error: "Custom key tidak boleh kosong" };
  if (/\s/.test(trimmed)) return { ok: false, error: "Custom key tidak boleh mengandung spasi" };
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return { ok: false, error: "Custom key hanya boleh huruf, angka, - dan _" };
  if (trimmed.length < 12) return { ok: false, error: "Custom key minimal 12 karakter" };
  if (trimmed.length > 128) return { ok: false, error: "Custom key maksimal 128 karakter" };
  return { ok: true, value: trimmed };
}

/**
 * Prefix of a standard-format key (multi-dash prefixes included), or null
 * when the value does not parse as a standard key (custom values, old format).
 * A HASHED stored value (see hashApiKey) carries its original prefix in the
 * second segment, so regenerate keeps the prefix after migration.
 * @param {string} apiKey
 * @returns {string | null}
 */
export function prefixOfStandardKey(apiKey) {
  const hashed = parseHashedApiKey(apiKey);
  if (hashed) return hashed.prefix || null;
  const parsed = parseApiKey(apiKey);
  if (!parsed || !parsed.isNewFormat) return null;
  const parts = apiKey.split("-");
  const prefix = parts.slice(0, parts.length - 3).join("-");
  return prefix || null;
}

// ─── Hashed storage (audit item 3) ──────────────────────────────────────
// Router keys are stored ONLY as a hash: `sha256:<prefix>:<last4>:<hex>`,
// where <hex> is SHA-256 of the exact presented value and <prefix>/<last4>
// are non-secret display hints (the dashboard already showed first-8 +
// last-4). The plaintext exists only in memory at creation/rotation time.
// A stored hash presented as a bearer token must NEVER authenticate:
// hashApiKey(storedHash) != storedHash, and the legacy lookup below
// rejects hashed rows outright.

// Stored-hash format guard. Custom keys may only contain [A-Za-z0-9_-]
// (validateCustomKey) and generated keys only dashes, so a ":" can never
// appear in a genuine plaintext key — the prefix is unambiguous.
export const HASHED_API_KEY_PREFIX = "sha256:";

/**
 * Hash a plaintext router key for storage. Deterministic: the same
 * presented value always maps to the same stored string, so the hash
 * column stays UNIQUE-indexable and lookups stay indexed.
 * @param {string} value exact presented/plaintext key (never trimmed here:
 *   the caller passes the exact value it validated/created)
 * @returns {string} `sha256:<prefix>:<last4>:<hex>`
 */
export function hashApiKey(value) {
  if (!value || typeof value !== "string") throw new Error("hashApiKey requires a key value");
  const digest = crypto.createHash("sha256").update(value, "utf8").digest("hex");
  const parsed = parseApiKey(value);
  const prefix = parsed?.isNewFormat
    ? value.split("-").slice(0, value.split("-").length - 3).join("-")
    : "";
  return `${HASHED_API_KEY_PREFIX}${prefix}:${value.slice(-4)}:${digest}`;
}

/**
 * Parse a stored hashed key, or null when the value is not hashed
 * (legacy plaintext) or malformed.
 * @param {string} stored
 * @returns {{ prefix: string, last4: string, digest: string } | null}
 */
export function parseHashedApiKey(stored) {
  if (!stored || typeof stored !== "string") return null;
  if (!stored.startsWith(HASHED_API_KEY_PREFIX)) return null;
  const parts = stored.slice(HASHED_API_KEY_PREFIX.length).split(":");
  if (parts.length !== 3) return null;
  const [prefix, last4, digest] = parts;
  if (!/^[A-Za-z0-9_-]*$/.test(prefix)) return null;
  if (!last4 || last4.length > 8) return null;
  if (!/^[0-9a-f]{64}$/.test(digest)) return null;
  return { prefix, last4, digest };
}

export function isHashedApiKey(stored) {
  return parseHashedApiKey(stored) !== null;
}

/** Last 4 of a stored key, hashed or legacy plaintext, or null. */
export function storedKeyLast4(stored) {
  const parsed = parseHashedApiKey(stored);
  if (parsed) return parsed.last4;
  if (typeof stored === "string" && stored.trim()) return stored.trim().slice(-4);
  return null;
}

/**
 * Constant-time verification of a presented key against a stored value
 * (hashed or legacy plaintext). ALWAYS compares fixed-length 32-byte
 * SHA-256 digests with crypto.timingSafeEqual — never the raw strings —
 * so comparison time does not leak how much of the key matched. A
 * malformed stored value fails closed (false, never throws: timingSafeEqual
 * throws on length mismatch, and both digests here are always 32 bytes).
 * @param {string} presented key as presented by the caller
 * @param {string} stored value from apiKeys.key (hashed or legacy plaintext)
 * @returns {boolean}
 */
export function verifyApiKeyHash(presented, stored) {
  if (!presented || typeof presented !== "string") return false;
  if (!stored || typeof stored !== "string") return false;
  const presentedDigest = crypto.createHash("sha256").update(presented, "utf8").digest();
  const parsed = parseHashedApiKey(stored);
  const storedDigest = parsed
    ? Buffer.from(parsed.digest, "hex")
    : crypto.createHash("sha256").update(stored, "utf8").digest();
  if (storedDigest.length !== presentedDigest.length) return false;
  return crypto.timingSafeEqual(presentedDigest, storedDigest);
}

/**
 * Parse API key and extract machineId + keyId
 * Supports both formats, with any non-empty prefix (letters, digits, - _):
 * - New: {prefix}-{machineId}-{keyId}-{crc8} (right-anchored, so a prefix
 *   containing "-" still parses: machineId/keyId/crc are the last 3 segments)
 * - Old: {prefix}-{keyId} = 2 parts
 * @param {string} apiKey
 * @returns {{ machineId: string, keyId: string, isNewFormat: boolean } | null}
 */
export function parseApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== "string") return null;

  const parts = apiKey.split("-");

  // New format: last 3 segments are machineId, keyId, crc; the rest is prefix.
  if (parts.length >= 4) {
    const prefix = parts.slice(0, parts.length - 3).join("-");
    const machineId = parts[parts.length - 3];
    const keyId = parts[parts.length - 2];
    const crc = parts[parts.length - 1];
    if (!/^[A-Za-z0-9_-]+$/.test(prefix) || !machineId || !keyId || !crc) return null;

    // Validate CRC
    const expectedCrc = generateCrc(machineId, keyId);
    if (crc !== expectedCrc) return null;

    return { machineId, keyId, isNewFormat: true };
  }

  // Old format: {prefix}-{keyId} = 2 parts
  if (parts.length === 2) {
    const [prefix, keyId] = parts;
    if (!/^[A-Za-z0-9_-]+$/.test(prefix) || !keyId) return null;
    return { machineId: null, keyId, isNewFormat: false };
  }

  return null;
}

/**
 * Verify API key CRC (only for new format)
 * @param {string} apiKey
 * @returns {boolean}
 */
export function verifyApiKeyCrc(apiKey) {
  const parsed = parseApiKey(apiKey);
  if (!parsed) return false;
  
  // Old format doesn't have CRC, always valid if parsed
  if (!parsed.isNewFormat) return true;
  
  // New format already verified in parseApiKey
  return true;
}

/**
 * Check if API key is new format (contains machineId)
 * @param {string} apiKey
 * @returns {boolean}
 */
export function isNewFormatKey(apiKey) {
  const parsed = parseApiKey(apiKey);
  return parsed?.isNewFormat === true;
}

