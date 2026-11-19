import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function rowToPool(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
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
