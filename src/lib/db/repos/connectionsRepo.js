import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { encryptSensitiveFields, decryptSensitiveFields } from "@/lib/atRestCrypto.js";
import { invalidateModelsListCache } from "../../../sse/services/modelsListCache.js";

// List-affecting subset of a connection: only these fields change what
// /v1/models publishes. Health writes (locks, errors, tokens) must NOT
// invalidate the models cache, or every failure storm would thrash it.
function modelsListSignature(conn) {
  const spec = conn?.providerSpecificData || {};
  return JSON.stringify([
    conn?.isActive,
    spec.enabledModels || null,
    spec.prefix || null,
  ]);
}

const OPTIONAL_FIELDS = [
  "displayName", "email", "globalPriority", "defaultModel",
  "accessToken", "refreshToken", "expiresAt", "tokenType",
  "scope", "projectId", "apiKey", "testStatus",
  "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn", "errorCode",
  "consecutiveUseCount", "idToken", "lastRefreshAt",
];

const MODEL_LOCK_PREFIX = "modelLock_";

function resetHealthStateOnActivation(existing, patch) {
  if (patch?.testStatus !== "active") return patch;

  const normalized = {
    ...patch,
    testStatus: "active",
    lastError: Object.hasOwn(patch, "lastError") ? patch.lastError : null,
    lastErrorAt: Object.hasOwn(patch, "lastErrorAt") ? patch.lastErrorAt : null,
    errorCode: null,
    rateLimitedUntil: null,
    backoffLevel: 0,
  };

  for (const key of Object.keys(existing || {})) {
    if (key.startsWith(MODEL_LOCK_PREFIX)) normalized[key] = null;
  }

  return normalized;
}

function rowToConn(row) {
  if (!row) return null;
  const extra = decryptSensitiveFields(parseJson(row.data, {}));
  return {
    ...extra,
    id: row.id,
    provider: row.provider,
    authType: row.authType,
    name: row.name,
    email: row.email,
    priority: row.priority,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function connToRow(c) {
  const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
  return {
    id,
    provider,
    authType,
    name: name ?? null,
    email: email ?? null,
    priority: priority ?? null,
    isActive: isActive === false ? 0 : 1,
    data: stringifyJson(encryptSensitiveFields(rest)),
    createdAt,
    updatedAt,
  };
}

function upsert(db, c) {
  const r = connToRow(c);
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       provider=excluded.provider, authType=excluded.authType, name=excluded.name,
       email=excluded.email, priority=excluded.priority, isActive=excluded.isActive,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.provider, r.authType, r.name, r.email, r.priority, r.isActive, r.data, r.createdAt, r.updatedAt]
  );
}

function deriveConnectionName(data, fallbackName) {
  if (data.provider === "github") {
    return data.providerSpecificData?.githubLogin
      || data.providerSpecificData?.githubEmail
      || data.email
      || data.providerSpecificData?.githubName
      || fallbackName;
  }
  return fallbackName;
}

export async function getProviderConnections(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.provider) { where.push("provider = ?"); params.push(filter.provider); }
  if (filter.isActive !== undefined) { where.push("isActive = ?"); params.push(filter.isActive ? 1 : 0); }
  const sql = `SELECT * FROM providerConnections${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  const rows = db.all(sql, params);
  const list = rows.map(rowToConn);
  list.sort((a, b) => (a.priority || 999) - (b.priority || 999));
  return list;
}

export async function getProviderConnectionById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
  return rowToConn(row);
}

// 9Router Pro: dashboard list-page stats, aggregated server-side so the
// providers page no longer downloads every connection (18k+ rows ≈ 7MB).
// Mirrors the page's own rules: "unavailable" counts as connected unless a
// modelLock_* is still in the future (cooldown), in which case it's an error.
export async function getProviderConnectionStats() {
  const db = await getAdapter();
  const rows = db.all(`SELECT provider, authType, isActive, data FROM providerConnections`);
  const nowMs = Date.now();
  const stats = {};
  for (const row of rows) {
    const extra = parseJson(row.data, {});
    const key = `${row.provider}|${row.authType}`;
    const s = (stats[key] ||= {
      provider: row.provider, authType: row.authType,
      total: 0, connected: 0, error: 0, allDisabled: true, latestError: null,
    });
    s.total++;
    if (row.isActive === 1 || row.isActive === true) s.allDisabled = false;
    const cooling = Object.entries(extra).some(
      ([k, v]) => k.startsWith(MODEL_LOCK_PREFIX) && v && new Date(v).getTime() > nowMs,
    );
    const status = extra.testStatus === "unavailable" && !cooling ? "active" : extra.testStatus;
    if (status === "active" || status === "success") {
      s.connected++;
    } else if (status === "error" || status === "expired" || status === "unavailable") {
      s.error++;
      if (!s.latestError || new Date(extra.lastErrorAt || 0) > new Date(s.latestError.lastErrorAt || 0)) {
        s.latestError = {
          lastErrorType: extra.lastErrorType || null,
          errorCode: extra.errorCode ?? null,
          lastError: extra.lastError || null,
          lastErrorAt: extra.lastErrorAt || null,
        };
      }
    }
  }
  return stats;
}

// 9Router Pro: server-side pagination + search for connection lists, so a
// provider with tens of thousands of keys loads one page at a time.
export async function getProviderConnectionsPage({ provider, page = 1, pageSize = 100, search = "" } = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (provider) { where.push("provider = ?"); params.push(provider); }
  const q = typeof search === "string" ? search.trim() : "";
  if (q) { where.push("(name LIKE ? OR email LIKE ?)"); params.push(`%${q}%`, `%${q}%`); }
  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const total = db.get(`SELECT COUNT(*) AS n FROM providerConnections${whereSql}`, params)?.n ?? 0;
  const safePage = Math.max(1, Math.floor(page) || 1);
  const safeSize = Math.min(500, Math.max(1, Math.floor(pageSize) || 100));
  const rows = db.all(
    `SELECT * FROM providerConnections${whereSql} ORDER BY priority ASC, createdAt ASC LIMIT ? OFFSET ?`,
    [...params, safeSize, (safePage - 1) * safeSize],
  );
  return { connections: rows.map(rowToConn), total, page: safePage, pageSize: safeSize };
}

// 9Router Pro: one UPDATE for a whole provider instead of one PUT per
// connection when toggling a provider on/off from the list page.
export async function bulkSetConnectionsActive(provider, authTypes, isActive) {
  if (!provider || !Array.isArray(authTypes) || !authTypes.length) return 0;
  const db = await getAdapter();
  const placeholders = authTypes.map(() => "?").join(", ");
  const info = db.run(
    `UPDATE providerConnections SET isActive = ?, updatedAt = ? WHERE provider = ? AND authType IN (${placeholders})`,
    [isActive ? 1 : 0, new Date().toISOString(), provider, ...authTypes],
  );
  if ((info?.changes ?? 0) > 0) invalidateModelsListCache();
  return info?.changes ?? 0;
}

// Assign a proxy pool to EVERY connection of a provider in one transaction,
// in the same order the detail page lists them (priority, createdAt).
// poolIds null/empty unbinds all; one id binds all to that pool; several ids
// rotate one-to-one across the connections. Returns the connection count.
export async function bulkAssignProxyPool(provider, poolIds) {
  if (!provider) return 0;
  const db = await getAdapter();
  const rows = db.all(
    `SELECT id, data FROM providerConnections WHERE provider = ? ORDER BY priority ASC, createdAt ASC`,
    [provider],
  );
  if (!rows.length) return 0;
  const now = new Date().toISOString();
  db.transaction(() => {
    rows.forEach((row, i) => {
      const data = parseJson(row.data, {});
      const spec = { ...(data.providerSpecificData || {}) };
      spec.proxyPoolId = poolIds && poolIds.length ? poolIds[i % poolIds.length] : null;
      data.providerSpecificData = spec;
      db.run(
        `UPDATE providerConnections SET data = ?, updatedAt = ? WHERE id = ?`,
        [stringifyJson(data), now, row.id],
      );
    });
  });
  return rows.length;
}

// Distinct proxy pool ids currently bound to any connection.
export async function getBoundProxyPoolIds() {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT DISTINCT json_extract(data, '$.providerSpecificData.proxyPoolId') AS pid FROM providerConnections WHERE json_extract(data, '$.providerSpecificData.proxyPoolId') IS NOT NULL`,
  );
  return rows.map((r) => r.pid).filter(Boolean);
}

// Internal sync reorder — must be called INSIDE a transaction.
//
// Normalizes priorities to a contiguous 1..N after a DELETE or an explicit
// reorder, so gaps don't accumulate over time.
//
// Deliberately NOT called on insert: a new connection already gets
// MAX(priority)+1, which sorts after every existing row, so the order is
// identical with or without the rewrite. Skipping it there is what makes
// import O(1) per key instead of O(pool) — see createProviderConnection.
function reorderInTx(db, providerId) {
  const list = db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [providerId]).map(rowToConn);
  list.sort((a, b) => {
    const pDiff = (a.priority || 0) - (b.priority || 0);
    if (pDiff !== 0) return pDiff;
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });
  list.forEach((c, i) => {
    const want = i + 1;
    if ((c.priority || 0) !== want) {
      db.run(`UPDATE providerConnections SET priority = ? WHERE id = ?`, [want, c.id]);
    }
  });
}

export async function createProviderConnection(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  let result;

  db.transaction(() => {
    // apikey connections are deduped by name and need only the current max
    // priority, so query for those directly instead of loading the whole pool
    // (O(pool) per key — the other half of the import cost in #4311). The oauth
    // branch below still scans, because its identity rules compare fields
    // inside providerSpecificData and have no single-column equivalent.
    const isApikey = data.authType === "apikey" && !!data.name;
    const all = isApikey
      ? db.all(
          `SELECT * FROM providerConnections WHERE provider = ? AND authType = ? AND name = ?`,
          [data.provider, "apikey", data.name]
        ).map(rowToConn)
      : db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [data.provider]).map(rowToConn);
    const poolSize = isApikey
      ? db.get(`SELECT COUNT(*) AS n FROM providerConnections WHERE provider = ?`, [data.provider])?.n ?? all.length
      : all.length;

    let existing = null;
    if (data.authType === "oauth" && data.email) {
      const incomingUsername = data.providerSpecificData?.username;
      const incomingWs = data.providerSpecificData?.chatgptAccountId;
      existing = all.find(c => {
        if (c.authType !== "oauth" || c.email !== data.email) return false;

        // Codex/OpenAI can issue multiple OAuth grants for the same email.
        // Refresh tokens are rotated single-use; collapsing a new login onto an
        // existing bare-email row overwrites the first account's token pair and
        // makes it look "invalid" after adding a second account. Only update an
        // existing Codex row when both rows expose the same ChatGPT account ID.
        if (data.provider === "codex") {
          const existingWs = c.providerSpecificData?.chatgptAccountId;
          return !!incomingWs && !!existingWs && incomingWs === existingWs;
        }

        // Workspace providers use workspace ID when both sides have it
        const existingWs = c.providerSpecificData?.chatgptAccountId;
        if (incomingWs && existingWs) return incomingWs === existingWs;
        if (incomingWs && !existingWs) return false;
        if (!incomingWs && existingWs) return false;
        // Non-workspace providers: match on (email + username) so cross-IdP
        // accounts don't overwrite each other. Require username on both sides
        // — if only one side has it, treat as a distinct identity rather than
        // collapsing onto the bare-email fallback (which would re-introduce
        // the cross-IdP overwrite).
        const existingUsername = c.providerSpecificData?.username;
        if (incomingUsername && existingUsername) {
          return incomingUsername === existingUsername;
        }
        if (incomingUsername || existingUsername) return false;
        return true;
      });
    } else if (data.authType === "apikey" && data.name) {
      existing = all.find(c => c.authType === "apikey" && c.name === data.name);
    }
    // access_token: never dedup — user manages duplicates manually

    if (existing) {
      // Name collision on an apikey connection used to silently replace the
      // stored apiKey, so a script that reused names ("Key 1", "Key 2", …)
      // destroyed existing pool entries with no 409 and no warning. Callers that
      // genuinely mean "update this one" pass allowOverwrite; everyone else gets
      // a typed error naming the row that would have been replaced. #4311
      if (data.allowOverwrite === false) {
        const err = new Error(
          `A connection named "${existing.name}" already exists for provider "${data.provider}". ` +
          `Pass allowOverwrite: true to replace it.`
        );
        err.code = "PROVIDER_NAME_CONFLICT";
        err.existingId = existing.id;
        err.existingName = existing.name;
        throw err;
      }
      const normalized = resetHealthStateOnActivation(existing, data);
      const merged = { ...existing, ...normalized, updatedAt: now };
      upsert(db, merged);
      result = merged;
      return;
    }

    let connectionName = data.name || null;
    if (!connectionName && (data.authType === "oauth" || data.authType === "access_token")) {
      connectionName = deriveConnectionName(data, data.email || `Account ${poolSize + 1}`);
    }
    let connectionPriority = data.priority;
    if (!connectionPriority) {
      // MAX(priority)+1 in SQL rather than a reduce over the loaded pool: the
      // apikey path no longer has the whole pool in memory, and the aggregate
      // is served by the index instead of a row scan. #4311
      const maxRow = db.get(`SELECT MAX(priority) AS m FROM providerConnections WHERE provider = ?`, [data.provider]);
      connectionPriority = (maxRow?.m || 0) + 1;
    }

    const conn = {
      id: uuidv4(),
      provider: data.provider,
      authType: data.authType || "oauth",
      name: connectionName,
      priority: connectionPriority,
      isActive: data.isActive !== undefined ? data.isActive : true,
      createdAt: now,
      updatedAt: now,
    };
    for (const f of OPTIONAL_FIELDS) {
      if (data[f] !== undefined && data[f] !== null) conn[f] = data[f];
    }
    if (data.providerSpecificData && Object.keys(data.providerSpecificData).length > 0) {
      conn.providerSpecificData = data.providerSpecificData;
    }
    if (data.email !== undefined) conn.email = data.email;

    upsert(db, conn);
    // No reorderInTx here. `conn.priority` is already MAX(priority)+1, so the
    // row sorts last and the resulting order is what reorderInTx would have
    // produced anyway. The rewrite cost ~2N statements per insert — O(pool) —
    // which made a 5k-key import O(n*m): ~25M statements at a 5k pool, and it
    // serialized every parallel writer on the same transaction. #4311
    result = conn;
  });

  invalidateModelsListCache();
  return result;
}

// Critical: OAuth refresh token race — atomic merge inside transaction
export async function updateProviderConnection(id, data) {
  const db = await getAdapter();
  let result;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
    if (!row) { result = null; return; }
    const existing = rowToConn(row);
    const beforeSig = modelsListSignature(existing);
    const normalized = resetHealthStateOnActivation(existing, data);
    const merged = { ...existing, ...normalized, updatedAt: new Date().toISOString() };
    // Re-enable is a deliberate operator action: a quarantined account
    // gets a fresh chance instead of re-quarantining on its next failure.
    if (existing.isActive === false && merged.isActive === true) {
      merged.consecutiveAuthFailures = 0;
      merged.quarantineReason = null;
      merged.quarantinedAt = null;
    }
    upsert(db, merged);
    if (data.priority !== undefined) reorderInTx(db, existing.provider);
    result = merged;
    if (modelsListSignature(merged) !== beforeSig) invalidateModelsListCache();
  });
  return result;
}

export async function deleteProviderConnection(id) {
  const db = await getAdapter();
  let ok = false;
  db.transaction(() => {
    const row = db.get(`SELECT provider FROM providerConnections WHERE id = ?`, [id]);
    if (!row) return;
    db.run(`DELETE FROM providerConnections WHERE id = ?`, [id]);
    reorderInTx(db, row.provider);
    ok = true;
  });
  if (ok) invalidateModelsListCache();
  return ok;
}

export async function deleteProviderConnectionsByProvider(providerId) {
  const db = await getAdapter();
  const before = db.get(`SELECT COUNT(*) AS n FROM providerConnections WHERE provider = ?`, [providerId]);
  db.run(`DELETE FROM providerConnections WHERE provider = ?`, [providerId]);
  const deleted = before?.n || 0;
  if (deleted > 0) invalidateModelsListCache();
  return deleted;
}

export async function reorderProviderConnections(providerId) {
  const db = await getAdapter();
  db.transaction(() => reorderInTx(db, providerId));
}

export async function cleanupProviderConnections() {
  const db = await getAdapter();
  const fieldsToCheck = [
    "displayName", "email", "globalPriority", "defaultModel",
    "accessToken", "refreshToken", "expiresAt", "tokenType",
    "scope", "projectId", "apiKey", "testStatus",
    "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn",
    "consecutiveUseCount",
  ];
  let cleaned = 0;
  db.transaction(() => {
    const rows = db.all(`SELECT * FROM providerConnections`);
    for (const row of rows) {
      const conn = rowToConn(row);
      let dirty = false;
      for (const f of fieldsToCheck) {
        if (conn[f] === null || conn[f] === undefined) {
          if (f in conn) { delete conn[f]; cleaned++; dirty = true; }
        }
      }
      if (conn.providerSpecificData && Object.keys(conn.providerSpecificData).length === 0) {
        delete conn.providerSpecificData;
        cleaned++;
        dirty = true;
      }
      if (dirty) upsert(db, conn);
    }
  });
  if (cleaned > 0) invalidateModelsListCache();
  return cleaned;
}
