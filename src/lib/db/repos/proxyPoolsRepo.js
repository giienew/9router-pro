import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { encryptValue, decryptValue } from "../../atRestCrypto.js";

// Proxy-pool credentials (the user:password embedded in proxyUrl) are
// encrypted at rest through the same atRestCrypto envelope as provider
// credentials (PRO_CREDENTIAL_KEY, AES-256-GCM). Only the password segment
// is encrypted, so the host/port stay readable for pool pickers and the
// value keeps working as a ProxyAgent URL after decryption on read.
// Without a key configured, encryptValue passes plaintext through — the
// same documented legacy fallback provider credentials use.
// Passwords containing a raw "@" must be URL-encoded when stored (standard
// URL userinfo rule); the split below takes the LAST "@" as the delimiter.
function splitProxyUrl(proxyUrl) {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?([^/?#]*)([\s\S]*)$/.exec(proxyUrl || "");
  if (!m) return null;
  const authority = m[2] || "";
  const at = authority.lastIndexOf("@");
  if (at === -1) return { scheme: m[1] || "", user: null, password: null, hostport: authority, rest: m[3] || "" };
  const userinfo = authority.slice(0, at);
  const colon = userinfo.indexOf(":");
  if (colon === -1) return { scheme: m[1] || "", user: userinfo, password: null, hostport: authority.slice(at + 1), rest: m[3] || "" };
  return {
    scheme: m[1] || "",
    user: userinfo.slice(0, colon),
    password: userinfo.slice(colon + 1),
    hostport: authority.slice(at + 1),
    rest: m[3] || "",
  };
}

function joinProxyUrl(p, password) {
  const auth = p.user === null ? p.hostport : `${p.user}:${password}@${p.hostport}`;
  return `${p.scheme}${auth}${p.rest}`;
}

function isEnvelopeText(value) {
  if (typeof value !== "string" || !value.startsWith("{")) return false;
  try {
    const p = JSON.parse(value);
    return p && p.v === 1 && typeof p.iv === "string" && typeof p.tag === "string" && typeof p.data === "string";
  } catch { return false; }
}

export function encryptProxyUrl(proxyUrl) {
  if (typeof proxyUrl !== "string" || !proxyUrl) return proxyUrl;
  const p = splitProxyUrl(proxyUrl);
  if (!p || p.password === null || p.password === "") return proxyUrl;
  let decoded = p.password;
  try { decoded = decodeURIComponent(p.password); } catch { /* keep raw */ }
  if (isEnvelopeText(decoded)) return proxyUrl; // already encrypted: never double-wrap
  const enc = encryptValue(decoded);
  if (enc === decoded) return proxyUrl; // no key configured: legacy plaintext passthrough
  return joinProxyUrl(p, encodeURIComponent(enc));
}

export function decryptProxyUrl(proxyUrl) {
  if (typeof proxyUrl !== "string" || !proxyUrl) return proxyUrl;
  const p = splitProxyUrl(proxyUrl);
  if (!p || p.password === null || p.password === "") return proxyUrl;
  let decoded = p.password;
  try { decoded = decodeURIComponent(p.password); } catch { return proxyUrl; }
  if (!isEnvelopeText(decoded)) return proxyUrl; // legacy plaintext pool
  const dec = decryptValue(decoded);
  if (dec === decoded) return proxyUrl; // key absent: leave the envelope intact, never corrupt it
  // Re-encode: a decrypted password may itself contain "@" or ":".
  return joinProxyUrl(p, encodeURIComponent(dec));
}

function rowToPool(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  if (typeof extra.proxyUrl === "string") extra.proxyUrl = decryptProxyUrl(extra.proxyUrl);
  return {
    ...extra,
    id: row.id,
    isActive: row.isActive === 1 || row.isActive === true,
    testStatus: row.testStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function poolToRow(p) {
  const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
  if (typeof rest.proxyUrl === "string") rest.proxyUrl = encryptProxyUrl(rest.proxyUrl);
  return {
    id,
    isActive: isActive === false ? 0 : 1,
    testStatus: testStatus ?? null,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, p) {
  const r = poolToRow(p);
  db.run(
    `INSERT INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       isActive=excluded.isActive, testStatus=excluded.testStatus,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.isActive, r.testStatus, r.data, r.createdAt, r.updatedAt]
  );
}

// Proxy URLs are consumed by undici's ProxyAgent, which only speaks
// http/https. A bare `host:port` (or `user:pass@host:port`) is normalized
// to http:// at use time. Any other scheme (ftp://, socks5://, ...) would
// fail confusingly at request time, so reject it at creation/update.
// Returns an error string, or null when the URL is acceptable.
export function validateProxyUrl(proxyUrl) {
  const value = typeof proxyUrl === "string" ? proxyUrl.trim() : "";
  if (!value) return "Proxy URL is required";
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(value);
  if (schemeMatch && schemeMatch[1].toLowerCase() !== "http" && schemeMatch[1].toLowerCase() !== "https") {
    return "Proxy URL scheme must be http:// or https://";
  }
  let parsed;
  try {
    parsed = new URL(schemeMatch ? value : `http://${value}`);
  } catch {
    return "Proxy URL is not a valid URL";
  }
  if (!parsed.hostname) {
    return "Proxy URL must include a host";
  }
  return null;
}

export async function getProxyPools(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.isActive !== undefined) { where.push("isActive = ?"); params.push(filter.isActive ? 1 : 0); }
  if (filter.testStatus) { where.push("testStatus = ?"); params.push(filter.testStatus); }
  const sql = `SELECT * FROM proxyPools${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  const list = db.all(sql, params).map(rowToPool);
  list.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  return list;
}

export async function getProxyPoolById(id) {
  const db = await getAdapter();
  return rowToPool(db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]));
}

export async function createProxyPool(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const pool = {
    id: data.id || uuidv4(),
    name: data.name,
    proxyUrl: data.proxyUrl,
    noProxy: data.noProxy || "",
    type: data.type || "http",
    isActive: data.isActive !== undefined ? data.isActive : true,
    strictProxy: data.strictProxy === true,
    testStatus: data.testStatus || "unknown",
    lastTestedAt: data.lastTestedAt || null,
    lastError: data.lastError || null,
    createdAt: now,
    updatedAt: now,
  };
  upsert(db, pool);
  return pool;
}

export async function updateProxyPool(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToPool(row), ...data, updatedAt: new Date().toISOString() };
    upsert(db, merged);
    result = merged;
  });
  return result;
}

export async function deleteProxyPool(id) {
  const db = await getAdapter();
  let removed = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]);
    if (!row) return;
    removed = rowToPool(row);
    db.run(`DELETE FROM proxyPools WHERE id = ?`, [id]);
  });
  return removed;
}

export async function deleteProxyPoolsByIds(ids) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  const db = await getAdapter();
  let changes = 0;
  db.transaction(() => {
    for (const id of ids) {
      const info = db.run(`DELETE FROM proxyPools WHERE id = ?`, [id]);
      changes += info?.changes ?? 0;
    }
  });
  return changes;
}

// Delete EVERY proxy pool and unpin every connection bound to a pool (back
// to DIRECT), in a single transaction. Unlike deleteProxyPoolsByIds, bound
// pools are NOT skipped — unpinning is the point. Other providerSpecificData
// fields on the connection are preserved; only proxyPoolId is cleared.
// Returns { deletedPools, unpinnedConnections }.
export async function deleteAllProxyPools() {
  const db = await getAdapter();
  let deletedPools = 0;
  let unpinnedConnections = 0;
  const now = new Date().toISOString();
  db.transaction(() => {
    const bound = db.all(
      `SELECT id, data FROM providerConnections WHERE json_extract(data, '$.providerSpecificData.proxyPoolId') IS NOT NULL`
    );
    for (const row of bound) {
      const data = parseJson(row.data, {});
      const spec = { ...(data.providerSpecificData || {}) };
      spec.proxyPoolId = null;
      data.providerSpecificData = spec;
      db.run(
        `UPDATE providerConnections SET data = ?, updatedAt = ? WHERE id = ?`,
        [stringifyJson(data), now, row.id]
      );
    }
    unpinnedConnections = bound.length;
    const info = db.run(`DELETE FROM proxyPools`);
    deletedPools = info?.changes ?? 0;
  });
  return { deletedPools, unpinnedConnections };
}
