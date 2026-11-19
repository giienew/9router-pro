// Spam / Abuse — server side: IP blocklist + ranking reads.
// Storage: the existing `kv` table, scope "blockedIps" (one row per IP) —
// the same pattern other small lists use (see src/lib/db/helpers/kvStore.js).
// SQLite persists it, so it survives PM2 restarts. No schema migration:
// the kv table already exists and ensureKvTable() creates it if missing.
// Enforcement lives in src/sse/services/keyAdmission.js (withKeyAdmission),
// the single funnel every provider-calling handler enters — the dashboard
// login never passes through it, so a blocked IP can never lock the admin
// out of the dashboard.
// Masked keys ONLY: ranking rows mask usageHistory.apiKey at read time;
// a full key never leaves this module.
import { getAdapter } from "./db/driver.js";
import { parseJson, stringifyJson } from "./db/helpers/jsonCol.js";
import { getClientIp } from "./auth/loginLimiter.js";
import { recordSecurityEvent } from "./trustEvents.js";
import { errorResponse } from "open-sse/utils/error.js";
import { maskApiKey } from "@/shared/utils/maskApiKey.js";
import {
  UNKNOWN_COUNTRY,
  UNKNOWN_IP,
  aggregateSpamRanking,
  countryFlag,
  countryFromHeaders,
  is429Status,
  isBlockableIp,
  isErrorStatus,
  normalizeIp,
} from "@/shared/utils/clientMeta.js";

export const BLOCKED_IPS_SCOPE = "blockedIps";
export const BLOCKED_IP_MESSAGE = "Access denied";

const PERIOD_MS = { "24h": 86400000, "7d": 604800000, "30d": 2592000000 };

function ensureKvTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS kv (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (scope, key))`);
}

async function getDb(dbOverride) {
  return dbOverride || (await getAdapter());
}

// Client attribution for a live Request. Reuses getClientIp (same trust
// rules as the login limiter) + cf-ipcountry. Never throws.
export function clientMetaFromRequest(request) {
  try {
    return {
      clientIp: getClientIp(request),
      country: countryFromHeaders(request?.headers),
    };
  } catch {
    return { clientIp: UNKNOWN_IP, country: UNKNOWN_COUNTRY };
  }
}

// --- Blocklist (KV scope "blockedIps", key = normalized IP) ---

export async function listBlockedIps(dbOverride) {
  const db = await getDb(dbOverride);
  ensureKvTable(db);
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ? ORDER BY key ASC`, [BLOCKED_IPS_SCOPE]);
  return rows.map((r) => {
    const v = parseJson(r.value, {}) || {};
    return {
      ip: r.key,
      country: v.country || UNKNOWN_COUNTRY,
      flag: countryFlag(v.country || UNKNOWN_COUNTRY),
      blockedAt: v.blockedAt || null,
      blockedBy: v.blockedBy || "dashboard",
      reason: v.reason || null,
    };
  });
}

export async function isIpBlocked(ip, dbOverride) {
  const n = normalizeIp(ip);
  if (!isBlockableIp(n)) return false;
  try {
    const db = await getDb(dbOverride);
    ensureKvTable(db);
    return !!db.get(`SELECT key FROM kv WHERE scope = ? AND key = ?`, [BLOCKED_IPS_SCOPE, n]);
  } catch {
    return false;
  }
}

export async function blockIp(ip, { country = UNKNOWN_COUNTRY, by = "dashboard", reason = null } = {}, dbOverride) {
  const n = normalizeIp(ip);
  if (!isBlockableIp(n)) throw new Error("Invalid IP address");
  const db = await getDb(dbOverride);
  ensureKvTable(db);
  const entry = {
    ip: n,
    country: /^[A-Za-z]{2}$/.test(String(country || "").trim()) ? String(country).trim().toUpperCase() : UNKNOWN_COUNTRY,
    blockedAt: new Date().toISOString(),
    blockedBy: by || "dashboard",
    reason: reason || null,
  };
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [BLOCKED_IPS_SCOPE, n, stringifyJson(entry)],
  );
  return entry;
}

export async function unblockIp(ip, dbOverride) {
  const n = normalizeIp(ip);
  if (!isBlockableIp(n)) return false;
  const db = await getDb(dbOverride);
  ensureKvTable(db);
  const info = db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [BLOCKED_IPS_SCOPE, n]);
  return (info?.changes ?? 0) > 0;
}

// Audit a block/unblock in the existing security log (R3 securityLog via
// recordSecurityEvent): who (dashboard admin session), when, which IP.
export function logBlockedIpAction(db, { action, ip, by = "dashboard" } = {}) {
  if (!db || !action || !ip) return null;
  return recordSecurityEvent(db, {
    event: action === "block" ? "ip-blocked" : "ip-unblocked",
    ip: normalizeIp(ip),
    detail: `${action === "block" ? "Blocked" : "Unblocked"} IP ${normalizeIp(ip)} via dashboard spam ranking (by ${by})`,
  });
}

// --- Enforcement ---
// Returns a 403 Response for a blacklisted IP, null otherwise. Fail-open:
// any lookup error lets the request through (a blocklist outage must not
// take the API down — same convention as key admission). The message is
// generic on purpose: it never confirms the IP is on a list.
// "unknown" IPs are never blocked: blocking that bucket would block every
// request whose IP could not be resolved.
export async function enforceBlockedIp(request, dbOverride) {
  try {
    const ip = getClientIp(request);
    if (!ip || ip === UNKNOWN_IP) return null;
    if (!(await isIpBlocked(ip, dbOverride))) return null;
    return errorResponse(403, BLOCKED_IP_MESSAGE);
  } catch (e) {
    console.warn("[spamAbuse] blocklist check failed, failing open:", e?.message || e);
    return null;
  }
}

// --- Ranking reads ---
// Volume comes from usageHistory (success rows carry clientIp/country in
// meta + the masked key at read time). Errors ALSO come from requestDetails:
// failed chat requests record a detail row (status "error", upstream code
// in data.response.status) but no usage row, so usageHistory alone would
// show zero errors. Detail rows whose id matches a usage requestId are
// skipped to avoid double-counting a request recorded in both tables.
export async function getSpamRanking({ period = "7d", limit = 50, dbOverride } = {}) {
  const db = await getDb(dbOverride);
  const lim = Math.min(200, Math.max(1, Math.floor(Number(limit)) || 50));
  const since = PERIOD_MS[period] ? new Date(Date.now() - PERIOD_MS[period]).toISOString() : null;
  const rows = [];
  const seenRequestIds = new Set();

  const usageRows = since
    ? db.all(`SELECT timestamp, status, meta, apiKey, requestId FROM usageHistory WHERE timestamp >= ? ORDER BY id DESC LIMIT 20000`, [since])
    : db.all(`SELECT timestamp, status, meta, apiKey, requestId FROM usageHistory ORDER BY id DESC LIMIT 20000`);
  for (const r of usageRows) {
    if (r.requestId) seenRequestIds.add(r.requestId);
    const m = parseJson(r.meta, {}) || {};
    rows.push({
      clientIp: m.clientIp || UNKNOWN_IP,
      country: m.country || UNKNOWN_COUNTRY,
      apiKeyMasked: maskApiKey(r.apiKey),
      status: r.status || "ok",
      timestamp: r.timestamp,
    });
  }

  const detailRows = since
    ? db.all(`SELECT id, timestamp, status, data FROM requestDetails WHERE status = 'error' AND timestamp >= ? ORDER BY timestamp DESC LIMIT 5000`, [since])
    : db.all(`SELECT id, timestamp, status, data FROM requestDetails WHERE status = 'error' ORDER BY timestamp DESC LIMIT 5000`);
  for (const r of detailRows) {
    if (r.id && seenRequestIds.has(r.id)) continue;
    const d = parseJson(r.data, {}) || {};
    const respStatus = d?.response?.status;
    rows.push({
      clientIp: d.clientIp || UNKNOWN_IP,
      country: d.country || UNKNOWN_COUNTRY,
      apiKeyMasked: d.apiKeyMasked || null,
      status: respStatus != null ? String(respStatus) : "error",
      timestamp: r.timestamp,
      is429: respStatus != null && String(respStatus) === "429",
    });
  }

  return { ...aggregateSpamRanking(rows, { limit: lim }), period, series: buildSeries(rows, period) };
}

// Time series for the Spam trend chart: bucket the same rows by time.
// 24h -> hourly (24 points), 7d -> 6-hourly (28), 30d/all -> daily (30).
// Each bucket: { label, requests, errors, rate429 }. No extra DB read.
function buildSeries(rows, period) {
  const bucketMs = period === "24h" ? 3600000 : period === "7d" ? 21600000 : 86400000;
  const count = period === "24h" ? 24 : period === "7d" ? 28 : 30;
  const now = Date.now();
  const start = Math.floor(now / bucketMs) * bucketMs - (count - 1) * bucketMs;
  const buckets = Array.from({ length: count }, (_, i) => ({
    label: "",
    requests: 0,
    errors: 0,
    rate429: 0,
    _t: start + i * bucketMs,
  }));
  for (const r of rows || []) {
    const t = new Date(r.timestamp).getTime();
    if (Number.isNaN(t) || t < start) continue;
    const idx = Math.min(count - 1, Math.floor((t - start) / bucketMs));
    if (idx < 0) continue;
    const b = buckets[idx];
    b.requests += 1;
    if (isErrorStatus(r.status)) b.errors += 1;
    if (is429Status(r.status) || r.is429) b.rate429 += 1;
  }
  for (const b of buckets) {
    const d = new Date(b._t);
    b.label = period === "24h"
      ? `${String(d.getHours()).padStart(2, "0")}:00`
      : `${d.getDate()}/${d.getMonth() + 1}`;
    delete b._t;
  }
  return buckets;
}

// Recent request log with attribution: newest first. Masked keys only.
export async function getRecentSpamLog({ limit = 50, dbOverride } = {}) {
  const db = await getDb(dbOverride);
  const lim = Math.min(200, Math.max(1, Math.floor(Number(limit)) || 50));
  const rows = db.all(
    `SELECT timestamp, provider, model, endpoint, status, meta, apiKey FROM usageHistory ORDER BY id DESC LIMIT ?`,
    [lim],
  );
  return rows.map((r) => {
    const m = parseJson(r.meta, {}) || {};
    const country = m.country || UNKNOWN_COUNTRY;
    return {
      timestamp: r.timestamp,
      provider: r.provider || "-",
      model: r.model || "-",
      endpoint: r.endpoint || "-",
      status: r.status || "ok",
      clientIp: m.clientIp || UNKNOWN_IP,
      country,
      flag: countryFlag(country),
      apiKeyMasked: maskApiKey(r.apiKey),
    };
  });
}
