// Capacity strategy (P3-28): order combo members by how much healthy
// capacity stands behind each one — the count of active, unlocked
// connections for the member's provider, with clean-tier (no recent
// failure) connections weighing far more than suspect ones. Stable sort:
// members with no connections keep their relative order at the back, so
// fallback is never broken by reordering, only reprioritised.
//
// This is a request-time ordering over live connection state, not a
// stored ranking: a provider that just lost its fleet drops to the back
// on the next request without any dashboard action.
import {
  connectionHealthTier,
  isModelLockActive,
} from "open-sse/services/accountFallback.js";
import { SUSPECT_PROBATION_MS } from "open-sse/config/errorConfig.js";
import { parseModel } from "open-sse/services/model.js";

/**
 * @param {string[]} models - combo members in current order
 * @param {object[]} connections - flattened provider connections
 * @param {object} [opts]
 * @param {function} [opts.resolveBacking] - (member) => backing "provider/model" | null (variants)
 * @param {number} [opts.now] - ms epoch (test seam)
 * @returns {string[]} the same members, capacity-ordered (stable)
 */
export function orderModelsByCapacity(models, connections = [], { resolveBacking = null, now = Date.now() } = {}) {
  if (!Array.isArray(models) || models.length <= 1) return models;
  const byProvider = new Map();
  for (const conn of connections) {
    if (!conn?.provider || conn.isActive === false) continue;
    const list = byProvider.get(conn.provider) || [];
    list.push(conn);
    byProvider.set(conn.provider, list);
  }
  const scoreOf = (member) => {
    const backing = resolveBacking ? resolveBacking(member) : null;
    const parsed = parseModel(backing || member);
    if (!parsed?.provider) return 0;
    const conns = byProvider.get(parsed.provider) || [];
    let clean = 0;
    let available = 0;
    for (const c of conns) {
      if (isModelLockActive(c, parsed.model)) continue;
      available += 1;
      if (connectionHealthTier(c, now, SUSPECT_PROBATION_MS) === 0) clean += 1;
    }
    return clean * 100 + available;
  };
  return models
    .map((m, i) => ({ m, i, s: scoreOf(m) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.m);
}
