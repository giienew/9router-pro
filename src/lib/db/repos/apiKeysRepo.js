import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { keyAccessFromColumns, keyAccessToColumns } from "@/shared/utils/keyAccess.js";
import { hashApiKey, isHashedApiKey, verifyApiKeyHash } from "@/shared/utils/apiKey.js";
import { KEY_ACCESS_UNRESTRICTED } from "@/shared/constants/keyAccess.js";
import { invalidateModelsListCache } from "@/sse/services/modelsListCache.js";
import { isInternalApiToken } from "@/lib/auth/internalToken.js";

// Audit item 3 — lazy migration: the live DB stores router keys in
// PLAINTEXT today. On the first successful validation of a still-plaintext
// row, replace the stored value with its hash IN PLACE (same id, same
// name, same access/expiry). The UPDATE is guarded by `AND key = ?` so a
// concurrent migration cannot clobber it, and any failure is swallowed:
// migration must never fail a validation that already succeeded.
function migrateStoredKeyToHash(db, row) {
  try {
    const hashed = hashApiKey(row.key);
    const res = db.run(`UPDATE apiKeys SET key = ? WHERE id = ? AND key = ?`, [hashed, row.id, row.key]);
    if ((res?.changes ?? 0) > 0) return { ...row, key: hashed };
  } catch {}
  return null;
}

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt || null,
    access: keyAccessFromColumns(row.accessRestricted, row.accessAllow),
  };
}

// Per-key policy (P3-26): a key is expired only when expiresAt parses to a
// date in the past. Garbage values fail open (treated as no expiry) so a
// corrupt row cannot lock out an otherwise valid key; the dashboard PUT
// route validates the format on write.
export function isKeyExpired(expiresAt, now = Date.now()) {
  if (!expiresAt) return false;
  const t = new Date(expiresAt).getTime();
  if (!Number.isFinite(t)) return false;
  return t <= now;
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

// Used by the /v1 handlers to read the presented key's access settings.
// Audit item 3: matches BOTH stored formats. (1) Hashed rows: indexed
// lookup by hashApiKey(presented), then a constant-time digest check.
// (2) Legacy plaintext rows: lookup by the presented value, constant-time
// digest check, then hash-in-place migration. A stored HASH presented as a
// bearer token never matches: hash(storedHash) != storedHash, and branch
// (2) rejects hashed rows outright.
export async function getApiKeyByKey(key) {
  if (!key) return null;
  const db = await getAdapter();
  let row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [hashApiKey(key)]);
  if (row && verifyApiKeyHash(key, row.key)) return rowToKey(row);
  row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return null;
  if (isHashedApiKey(row.key)) return null;
  if (!verifyApiKeyHash(key, row.key)) return null;
  return rowToKey(migrateStoredKeyToHash(db, row) || row);
}

export async function createApiKey(name, machineId, opts = {}) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  // opt10: a custom value is stored verbatim (generation skipped); a
  // generated value retries on (extremely unlikely) collision.
  let key;
  if (typeof opts.customKey === "string" && opts.customKey.trim() !== "") {
    key = opts.customKey.trim();
  } else {
    let generated = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateApiKeyWithMachine(machineId, opts.prefix);
      if (!(await getApiKeyByKey(candidate.key))) { generated = candidate; break; }
    }
    if (!generated) throw new Error("Failed to generate a unique key");
    key = generated.key;
  }
  const expiresAt = opts.expiresAt || null;
  // Audit item 3: only the HASH is stored. The returned object's `key` is
  // the plaintext value, held in memory ONLY so the POST 201 creation
  // response can disclose it once; it is never written to the DB and no
  // read path ever returns it again. getApiKeys/getApiKeyById return the
  // stored (hashed) value in `key` — callers must not treat it as a secret.
  const storedKey = hashApiKey(key);
  const apiKey = {
    id: uuidv4(),
    name,
    key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
    expiresAt,
    access: { restricted: false, allow: [] },
  };
  const cols = keyAccessToColumns(KEY_ACCESS_UNRESTRICTED);
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, expiresAt, accessRestricted, accessAllow) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, storedKey, apiKey.name, apiKey.machineId, 1, apiKey.createdAt, expiresAt, cols.accessRestricted, cols.accessAllow]
  );
  invalidateModelsListCache();
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    // Audit item 3: a new plaintext value (regenerate / custom) is hashed
    // before it is written. A value that is already a stored hash (e.g. a
    // record round-tripped through a read) is stored as-is, never double-
    // hashed — hashApiKey(hash) would be unverifiable.
    const storedKey =
      typeof merged.key === "string" && merged.key && !isHashedApiKey(merged.key)
        ? hashApiKey(merged.key)
        : merged.key;
    const cols = keyAccessToColumns(merged.access);
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, expiresAt = ?, accessRestricted = ?, accessAllow = ? WHERE id = ?`,
      [storedKey, merged.name, merged.machineId, merged.isActive ? 1 : 0, merged.expiresAt || null, cols.accessRestricted, cols.accessAllow, id]
    );
    result = rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]));
  });
  if (result) invalidateModelsListCache();
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  const ok = (res?.changes ?? 0) > 0;
  if (ok) invalidateModelsListCache();
  return ok;
}

export async function validateApiKey(key) {
  if (!key) return false;
  // (0) Internal service token (server-side consumers only): valid and
  // unrestricted, never expires. Checked first so internal callers never
  // depend on a user key's plaintext.
  if (await isInternalApiToken(key).catch(() => false)) return true;
  const db = await getAdapter();
  // (1) Hashed rows: indexed hash lookup + constant-time digest check.
  let row = db.get(`SELECT isActive, expiresAt, key FROM apiKeys WHERE key = ?`, [hashApiKey(key)]);
  if (row && verifyApiKeyHash(key, row.key)) {
    if (!(row.isActive === 1 || row.isActive === true)) return false;
    return !isKeyExpired(row.expiresAt);
  }
  // (2) Legacy plaintext rows: validate, then hash in place (lazy
  // migration — the Hermes/ONWER key keeps working on its very first
  // request after deploy, and every request after). A stored hash
  // presented as a bearer token is rejected here, never validated.
  row = db.get(`SELECT id, isActive, expiresAt, key FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  if (isHashedApiKey(row.key)) return false;
  if (!verifyApiKeyHash(key, row.key)) return false;
  migrateStoredKeyToHash(db, row);
  if (!(row.isActive === 1 || row.isActive === true)) return false;
  return !isKeyExpired(row.expiresAt);
}
