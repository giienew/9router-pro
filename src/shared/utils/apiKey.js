import crypto from "crypto";

const API_KEY_SECRET = process.env.API_KEY_SECRET || "endpoint-proxy-api-key-secret";

/**
 * Generate 6-char random keyId
 */
function generateKeyId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
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

