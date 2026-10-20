// Key Quotas (9Router Pro) — per-API-key token budgets over a rolling
// window. Upstream removed its quota implementation (revert 6ed8868); Pro
// brings it back lean: config in KV, usage summed from usageHistory.
//
//   scope "keyQuotas": key = api key id,
//   value = { enabled, limit, windowHours }
//
// Enforcement is a soft, per-request pre-check in the chat handler
// (fail-open: a quota lookup error never blocks a chat).

import { makeKv } from "../helpers/kvStore.js";
import { getAdapter } from "../driver.js";

const quotasKv = makeKv("keyQuotas");

export const QUOTA_WINDOWS = [24, 168, 720]; // 24h, 7d, 30d

export function cleanQuota(raw) {
  if (!raw || typeof raw !== "object") return null;
  const limit = Math.floor(Number(raw.limit));
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const windowHours = QUOTA_WINDOWS.includes(Number(raw.windowHours)) ? Number(raw.windowHours) : 24;
  return { enabled: raw.enabled !== false, limit, windowHours };
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
export async function getKeyUsageInWindow(rawKey, windowHours) {
  if (!rawKey) return 0;
  const cutoff = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();
  const db = await getAdapter();
  const row = db.get(
    `SELECT COALESCE(SUM(COALESCE(promptTokens, 0) + COALESCE(completionTokens, 0)), 0) AS used
     FROM usageHistory WHERE apiKey = ? AND timestamp >= ?`,
    [rawKey, cutoff]
  );
  return Number(row?.used) || 0;
}

// Decision used by the chat handler; never throws.
export async function checkKeyQuota(keyId, rawKey) {
  try {
    const quota = await getKeyQuota(keyId);
    if (!quota || !quota.enabled) return { blocked: false };
    const used = await getKeyUsageInWindow(rawKey, quota.windowHours);
    if (used >= quota.limit) return { blocked: true, quota, used };
    return { blocked: false, quota, used };
  } catch {
    return { blocked: false };
  }
}
