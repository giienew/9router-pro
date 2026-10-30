// At-rest credential encryption (R6, 9Router Pro, original code).
// AES-256-GCM over the sensitive fields of a connection's stored `data`
// JSON (API keys, OAuth access/refresh/id tokens, client secrets).
// Key: env PRO_CREDENTIAL_KEY — 64 hex chars or base64 of 32 bytes.
// The key is NEVER logged and NEVER committed; without it, writes stay
// plaintext (legacy) and reads fall back to plaintext, so existing
// connections never break. With it, new/updated credentials encrypt on
// write and legacy rows decrypt transparently; an explicit migration
// (POST /api/settings/encryption) re-writes legacy rows through the same
// encrypt-on-write path. Migration is reversible: decrypt with the same
// key, or re-save with the key unset, restores plaintext.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const SENSITIVE_FIELDS = ["apiKey", "accessToken", "refreshToken", "idToken", "secret", "clientSecret", "token"];

export function getEncryptionKey() {
  const raw = (process.env.PRO_CREDENTIAL_KEY || "").trim();
  if (!raw) return null;
  try {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
    const buf = Buffer.from(raw, "base64");
    if (buf.length === 32) return buf;
  } catch {}
  return null;
}

export function isKeyConfigured() { return getEncryptionKey() !== null; }

function isEnvelope(value) {
  if (typeof value !== "string") return false;
  try { const p = JSON.parse(value); return p && p.v === 1 && typeof p.iv === "string" && typeof p.tag === "string" && typeof p.data === "string"; } catch { return false; }
}

export function encryptValue(plaintext) {
  const key = getEncryptionKey();
  if (!key || typeof plaintext !== "string") return plaintext;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
}

export function decryptValue(value) {
  if (!isEnvelope(value)) return value;
  const key = getEncryptionKey();
  if (!key) return value; // key absent: leave the envelope intact, never crash reads
  try {
    const p = JSON.parse(value);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(p.iv, "base64"));
    decipher.setAuthTag(Buffer.from(p.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(p.data, "base64")), decipher.final()]).toString("utf8");
  } catch { return value; }
}

function mapFields(obj, fn) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const out = { ...obj };
  for (const f of SENSITIVE_FIELDS) {
    if (typeof out[f] === "string") out[f] = fn(out[f]);
  }
  if (out.providerSpecificData && typeof out.providerSpecificData === "object" && !Array.isArray(out.providerSpecificData)) {
    const spec = { ...out.providerSpecificData };
    for (const f of SENSITIVE_FIELDS) {
      if (typeof spec[f] === "string") spec[f] = fn(spec[f]);
    }
    out.providerSpecificData = spec;
  }
  return out;
}

export function encryptSensitiveFields(obj) { return mapFields(obj, encryptValue); }
export function decryptSensitiveFields(obj) { return mapFields(obj, decryptValue); }

export function countRowEncryption(dataObj) {
  let plaintext = 0;
  let encrypted = 0;
  const scan = (o) => {
    if (!o || typeof o !== "object") return;
    for (const f of SENSITIVE_FIELDS) {
      if (typeof o[f] === "string" && o[f]) {
        if (isEnvelope(o[f])) encrypted++; else plaintext++;
      }
    }
    if (o.providerSpecificData && typeof o.providerSpecificData === "object") scan(o.providerSpecificData);
  };
  scan(dataObj);
  return { plaintext, encrypted };
}

// Explicit, non-destructive migration: re-writes rows that still hold any
// plaintext sensitive field through encrypt-on-write. Dry-run counts only.
export async function migrateConnectionsEncryption({ dryRun = true } = {}) {
  const { getAdapter } = await import("@/lib/db/driver.js");
  const { parseJson, stringifyJson } = await import("@/lib/db/helpers/jsonCol.js");
  const db = await getAdapter();
  const rows = db.all(`SELECT id, data FROM providerConnections`);
  let wouldMigrate = 0;
  let migrated = 0;
  for (const row of rows) {
    const data = parseJson(row.data, {});
    const { plaintext } = countRowEncryption(data);
    if (!plaintext) continue;
    wouldMigrate++;
    if (!dryRun) {
      const next = encryptSensitiveFields(data);
      db.run(`UPDATE providerConnections SET data = ?, updatedAt = ? WHERE id = ?`, [stringifyJson(next), new Date().toISOString(), row.id]);
      migrated++;
    }
  }
  return { scanned: rows.length, wouldMigrate, migrated, keyConfigured: isKeyConfigured() };
}
