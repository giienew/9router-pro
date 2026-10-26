import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function rowToNode(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    type: row.type,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function nodeToRow(n) {  const { id, type, name, createdAt, updatedAt, ...rest } = n;
  return {
    id,
    type: type ?? null,
    name: name ?? null,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, n) {
  const r = nodeToRow(n);
  db.run(
    `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type=excluded.type, name=excluded.name, data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.type, r.name, r.data, r.createdAt, r.updatedAt]
  );
}

// Resolve a backing address to a routable one (pure — no DB access).
// The chat path does NOT map custom-provider alias prefixes (e.g.
// "tokenharbor/...") to node ids, so a backing saved with an alias
// prefix would 404 at runtime. Convert it at save time:
//   · provider part already a node id  -> unchanged (routable)
//   · provider part matches exactly one node's prefix -> node id form
//   · provider part matches several nodes' prefixes -> null (ambiguous:
//     refuse rather than route to the wrong node)
//   · anything else (native provider, unknown) -> unchanged; the caller
//     keeps today's behavior for those.
export function resolveRoutableBacking(model, nodes = []) {
  if (typeof model !== "string") return model;
  const slash = model.indexOf("/");
  if (slash <= 0) return model;
  const providerPart = model.slice(0, slash);
  const rest = model.slice(slash + 1);
  if (!Array.isArray(nodes) || nodes.length === 0) return model;
  if (nodes.some((n) => n?.id === providerPart)) return model;
  const byPrefix = nodes.filter((n) => n?.prefix === providerPart);
  if (byPrefix.length === 1) return `${byPrefix[0].id}/${rest}`;
  if (byPrefix.length > 1) return null;
  return model;
}

// Normalize a combo member list to routable addresses (same AUTO rule as
// variants, but bulk-tolerant: an ambiguous member is left as-is instead
// of failing the whole save — the common alias case still gets fixed).
// `nodes` is injectable for tests; when omitted it is read from the DB.
export async function normalizeRoutableMembers(models, nodes = null) {
  if (!Array.isArray(models)) return models;
  const list = nodes ?? (await getProviderNodes().catch(() => []));
  return models.map((m) => {
    if (typeof m !== "string") return m;
    const routed = resolveRoutableBacking(m, list);
    return routed === null ? m : routed;
  });
}

export async function getProviderNodes(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.type) { where.push("type = ?"); params.push(filter.type); }
  const sql = `SELECT * FROM providerNodes${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  return db.all(sql, params).map(rowToNode);
}

export async function getProviderNodeById(id) {
  const db = await getAdapter();
  return rowToNode(db.get(`SELECT * FROM providerNodes WHERE id = ?`, [id]));
}

export async function createProviderNode(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const node = {
    id: data.id || uuidv4(),
    type: data.type,
    name: data.name,
    prefix: data.prefix,
    apiType: data.apiType,
    baseUrl: data.baseUrl,
    createdAt: now,
    updatedAt: now,
  };
  upsert(db, node);
  return node;
}

export async function updateProviderNode(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM providerNodes WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToNode(row), ...data, updatedAt: new Date().toISOString() };
    upsert(db, merged);
    result = merged;
  });
  return result;
}

export async function deleteProviderNode(id) {
  const db = await getAdapter();
  let removed = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM providerNodes WHERE id = ?`, [id]);
    if (!row) return;
    removed = rowToNode(row);
    db.run(`DELETE FROM providerNodes WHERE id = ?`, [id]);
    db.run(`DELETE FROM kv WHERE scope = 'customModels' AND key LIKE ?`, [`${id}|%`]);
  });
  return removed;
}
