// Key Quotas (9Router Pro) — per-API-key token budgets.
// Two modes (PATCH-ABCE, 2026-11-19):
//   - rolling window: usage inside the last `windowHours` (24h/7d/30d).
//   - absolute (lifetime): `absolute === true` → usage counted since
//     `resetAt` (or epoch when absent); `windowHours` is kept as a formal
//     default and ignored. `windowHours: 0` still means all-time too
//     (legacy, from the Cristaline all-time window) so older quotas keep
//     working.
// `resetAt` (ISO string) is the manual-reset baseline: usage before it is
// ignored, so a reset zeroes the counter without deleting usageHistory.
//
//   scope "keyQuotas": key = api key id,
//   value = { enabled, limit, windowHours, costLimit?, absolute?, resetAt? }
//
// costLimit (P3-26, optional, USD) caps the same window's spend, summed
// from usageHistory.cost. Token and cost blocks are independent: hitting
// either one blocks the request.
//
// Enforcement is a soft, per-request pre-check in the chat handler
// (fail-open: a quota lookup error never blocks a chat).

import { makeKv } from "../helpers/kvStore.js";
import { getAdapter } from "../driver.js";
import { hashApiKey, isHashedApiKey } from "@/shared/utils/apiKey.js";

const quotasKv = makeKv("keyQuotas");

export const QUOTA_WINDOWS = [0, 24, 168, 720]; // 0 = all time, 24h, 7d, 30d

export function cleanQuota(raw) {
  if (!raw || typeof raw !== "object") return null;
  const limit = Math.floor(Number(raw.limit));
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const windowHours = QUOTA_WINDOWS.includes(Number(raw.windowHours)) ? Number(raw.windowHours) : 24;
  const out = { enabled: raw.enabled !== false, limit, windowHours };
  const costLimit = Number(raw.costLimit);
  if (Number.isFinite(costLimit) && costLimit > 0) out.costLimit = costLimit;
  // absolute (boolean): lifetime mode — usage counted since resetAt (or
  // epoch), windowHours ignored. Preserved verbatim like resetAt so a
  // quota PATCH that does not mention it keeps it.
  if (raw.absolute === true) out.absolute = true;
  // resetAt (ISO string): manual quota reset — usage before it is ignored.
  // Preserved verbatim so a quota PATCH that does not mention it keeps it.
  if (typeof raw.resetAt === "string" && !Number.isNaN(Date.parse(raw.resetAt))) {
    out.resetAt = raw.resetAt;
  }
  return out;
}

// Lifetime (all-time) quota: absolute mode, or the legacy windowHours 0.
export function isLifetimeQuota(quota) {
  if (!quota || typeof quota !== "object") return false;
  return quota.absolute === true || Number(quota.windowHours) === 0;
}

export async function getKeyQuota(keyId) {
  if (!keyId) return null;
  return cleanQuota(await quotasKv.get(keyId));
}

export async function getAllKeyQuotas() {
  const all = (await quotasKv.getAll?.()) || {};
  const out = {};
  for (const [id, raw] of Object.entries(all)) {
    const q = cleanQuota(raw);
    if (q) out[id] = q;
  }
  return out;
}

export async function setKeyQuota(keyId, quota) {
  const clean = cleanQuota(quota);
  if (!clean) {
    await quotasKv.remove(keyId);
    return null;
  }
  await quotasKv.set(keyId, clean);
  return clean;
}

export async function deleteKeyQuota(keyId) {
  await quotasKv.remove(keyId);
}

// Total tokens (prompt + completion) a raw key value burned inside the
// rolling window, summed from usageHistory (timestamps are ISO strings).
// `since` (ISO string, from quota.resetAt) is a floor: usage before it is
// ignored, so a manual reset zeroes the counter without deleting history.
// Lifetime mode (`absolute === true`, or legacy windowHours 0) = all time:
// no window cutoff, only `since` applies.
//
// Audit item 3 (pro.29): usageHistory.apiKey stores the PLAINTEXT key the
// client presented, but the dashboard passes the STORED value — which is
// now a hash (`sha256:...`) for migrated rows. A plain `WHERE apiKey = ?`
// then matches nothing and the display reads 0. So when `rawKey` is a
// stored hash, match rows whose apiKey hashes to it (JS filter over the
// window's rows). The hot enforcement path (checkKeyQuota) passes the
// presented plaintext and keeps the fast indexed equality query.
export async function getKeyUsageInWindow(rawKey, windowHours, since, absolute) {
  if (!rawKey) return 0;
  const lifetime = absolute === true || Number(windowHours) === 0;
  const windowCutoff = lifetime ? 0 : Date.now() - Number(windowHours) * 3600 * 1000;
  const sinceMs = since ? Date.parse(since) : NaN;
  const cutoff = new Date(Math.max(windowCutoff, Number.isNaN(sinceMs) ? 0 : sinceMs)).toISOString();
  const db = await getAdapter();
  if (!isHashedApiKey(rawKey)) {
    const row = db.get(
      `SELECT COALESCE(SUM(COALESCE(promptTokens, 0) + COALESCE(completionTokens, 0)), 0) AS used
       FROM usageHistory WHERE apiKey = ? AND timestamp >= ?`,
      [rawKey, cutoff]
    );
    return Number(row?.used) || 0;
  }
  const rows = db.all(
    `SELECT apiKey, promptTokens, completionTokens FROM usageHistory WHERE timestamp >= ?`,
    [cutoff]
  );
  let used = 0;
  for (const r of rows) {
    if (!r.apiKey || typeof r.apiKey !== "string") continue;
    if (r.apiKey === rawKey || hashApiKey(r.apiKey) === rawKey) used += (Number(r.promptTokens) || 0) + (Number(r.completionTokens) || 0);
  }
  return used;
}

// Total USD spend a raw key value burned inside the rolling window.
export async function getKeyCostInWindow(rawKey, windowHours, since, absolute) {
  if (!rawKey) return 0;
  const lifetime = absolute === true || Number(windowHours) === 0;
  const windowCutoff = lifetime ? 0 : Date.now() - Number(windowHours) * 3600 * 1000;
  const sinceMs = since ? Date.parse(since) : NaN;
  const cutoff = new Date(Math.max(windowCutoff, Number.isNaN(sinceMs) ? 0 : sinceMs)).toISOString();
  const db = await getAdapter();
  if (!isHashedApiKey(rawKey)) {
    const row = db.get(
      `SELECT COALESCE(SUM(COALESCE(cost, 0)), 0) AS spent
       FROM usageHistory WHERE apiKey = ? AND timestamp >= ?`,
      [rawKey, cutoff]
    );
    return Number(row?.spent) || 0;
  }
  const rows = db.all(
    `SELECT apiKey, cost FROM usageHistory WHERE timestamp >= ?`,
    [cutoff]
  );
  let spent = 0;
  for (const r of rows) {
    if (!r.apiKey || typeof r.apiKey !== "string") continue;
    if (r.apiKey === rawKey || hashApiKey(r.apiKey) === rawKey) spent += Number(r.cost) || 0;
  }
  return spent;
}

// Move a key's quota baseline to now (manual reset). Usage history is
// kept; the counter restarts from resetAt. Returns the saved quota.
export async function resetKeyQuota(keyId) {
  const quota = await getKeyQuota(keyId);
  if (!quota) return null;
  return setKeyQuota(keyId, { ...quota, resetAt: new Date().toISOString() });
}

// Decision used by the chat handler; never throws.
export async function checkKeyQuota(keyId, rawKey) {
  try {
    const quota = await getKeyQuota(keyId);
    if (!quota || !quota.enabled) return { blocked: false };
    const used = await getKeyUsageInWindow(rawKey, quota.windowHours, quota.resetAt, quota.absolute);
    if (used >= quota.limit) return { blocked: true, quota, used };
    if (quota.costLimit) {
      const costUsed = await getKeyCostInWindow(rawKey, quota.windowHours, quota.resetAt, quota.absolute);
      if (costUsed >= quota.costLimit) {
        return { blocked: true, costBlocked: true, quota, used, costUsed };
      }
      return { blocked: false, quota, used, costUsed };
    }
    return { blocked: false, quota, used };
  } catch {
    return { blocked: false };
  }
}
