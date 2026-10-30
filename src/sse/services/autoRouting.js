// Scored auto-routing (P3-25): one word expresses intent, Pro's own health
// and capability data picks the model. A client calls `auto:<intent>` as the
// model; the router expands it into a ranked candidate list and falls back
// through it in order, exactly like a combo (same member cap, same
// failover). No LLM judge is involved — this is deterministic scoring, so
// it costs no extra inference call.
//
// Candidate pool: registry-seeded models of providers that have at least
// one ACTIVE connection. Providers without seed models contribute nothing
// (inventing model ids would 404 upstream); inject variants are never
// candidates (a variant carries a user prompt — auto-routing must not
// silently inject one). Disabled models (dashboard disabled list) and a
// connection's enabledModels restriction are honoured.
//
// Scoring inputs, all already on hand:
//   * health tier (open-sse connectionHealthTier, same as balanced
//     selection): clean = 100, suspect = 0. Suspects still serve — they
//     just sort last, so a fully-suspect fleet still routes.
//   * capabilities (getCapabilitiesForModel): tools / reasoning /
//     contextWindow. "fast" has no latency history to score from
//     (usageHistory records no latency), so it uses small context as a
//     proxy — documented here, not hidden: swap in measured p50 latency
//     when a latency column exists.
//   * free-ness: FREE_PROVIDERS ids, or a `:free` model-id suffix
//     (tokenharbor campaign convention).
// Ties break alphabetically so the ranking is deterministic per fleet.

import REGISTRY from "open-sse/providers/registry/index.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { connectionHealthTier } from "open-sse/services/accountFallback.js";
import { SUSPECT_PROBATION_MS } from "open-sse/config/errorConfig.js";
import { FREE_PROVIDERS } from "@/shared/constants/providers.js";

export const AUTO_INTENTS = ["coding", "fast", "cheap", "headroom"];
export const AUTO_CANDIDATE_LIMIT = 8;
// At most this many candidates per provider in the final list, so failover
// spans providers instead of collapsing to one provider's catalogue when
// that provider's seeds all outscore everyone else's.
export const AUTO_PER_PROVIDER_LIMIT = 3;

// `auto:coding` (case-insensitive) → "coding"; anything else → null.
export function parseAutoTarget(modelStr) {
  if (typeof modelStr !== "string") return null;
  const m = /^auto:([a-z]+)$/i.exec(modelStr.trim());
  if (!m) return null;
  const intent = m[1].toLowerCase();
  return AUTO_INTENTS.includes(intent) ? intent : null;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// 0..40 from context size: 4k → 6, 32k → 15, 200k → 23, 1M → 30.
const ctxScore = (ctx) =>
  clamp(Math.round(10 * Math.log10(Math.max(1000, ctx || 1000) / 1000)), 0, 40);

function isFree(providerId, modelId) {
  if (FREE_PROVIDERS && Object.prototype.hasOwnProperty.call(FREE_PROVIDERS, providerId)) return true;
  return typeof modelId === "string" && modelId.endsWith(":free");
}

// enabledModels entries may be bare model ids ("deepseek-ai/..."), full
// "provider/model" strings, or provider-prefixed variants — match on the
// model part (everything after the FIRST slash of the entry).
function enabledMatches(seedId, entries, providerId) {
  if (!Array.isArray(entries) || entries.length === 0) return true;
  return entries.some((e) => {
    if (typeof e !== "string") return false;
    if (e === seedId || e === `${providerId}/${seedId}`) return true;
    const slash = e.indexOf("/");
    return slash >= 0 && e.slice(slash + 1) === seedId;
  });
}

function scoreCandidate(intent, caps, health, free) {
  const ctx = ctxScore(caps.contextWindow);
  switch (intent) {
    case "coding":
      return health + (caps.tools ? 30 : 0) + (caps.reasoning ? 20 : 0) + ctx;
    case "fast":
      return health + (40 - ctx);
    case "cheap":
      return health + (free ? 60 : 0) + Math.round((20 - ctx / 2));
    case "headroom":
      return health + ctx * 2;
    default:
      return health;
  }
}

const providerOf = (candidate) => candidate.slice(0, candidate.indexOf("/"));

/**
 * Rank auto-routing candidates for an intent.
 * @param {object} opts
 * @param {string} opts.intent - one of AUTO_INTENTS
 * @param {object[]} opts.connections - flattened provider connections
 * @param {object} [opts.disabled] - disabled-models map { alias: [modelId] }
 * @param {number} [opts.now] - ms epoch (test seam)
 * @returns {string[]} ranked `provider/modelId` strings, capped.
 */
export function buildAutoCandidates({ intent, connections = [], disabled = {}, now = Date.now() }) {
  if (!AUTO_INTENTS.includes(intent)) return [];
  const byProvider = new Map();
  for (const conn of connections) {
    if (!conn?.provider || conn.isActive === false) continue;
    const entry = byProvider.get(conn.provider) || { tier: 1, enabled: null };
    const tier = connectionHealthTier(conn, now, SUSPECT_PROBATION_MS);
    entry.tier = Math.min(entry.tier, tier);
    const enabled = conn.providerSpecificData?.enabledModels;
    if (Array.isArray(enabled)) {
      entry.enabled = entry.enabled ? [...new Set([...entry.enabled, ...enabled])] : [...enabled];
    }
    byProvider.set(conn.provider, entry);
  }

  const scored = [];
  for (const reg of REGISTRY) {
    const prov = byProvider.get(reg.id);
    if (!prov || !Array.isArray(reg.models)) continue;
    const health = prov.tier === 0 ? 100 : 0;
    const disabledIds = new Set([
      ...(disabled[reg.id] || []),
      ...(reg.alias ? disabled[reg.alias] || [] : []),
      ...((reg.aliases || []).flatMap((a) => disabled[a] || [])),
    ]);
    for (const seed of reg.models) {
      if (!seed?.id || disabledIds.has(seed.id)) continue;
      if (!enabledMatches(seed.id, prov.enabled, reg.id)) continue;
      const candidate = `${reg.id}/${seed.id}`;
      if (disabledIds.has(candidate)) continue;
      const caps = getCapabilitiesForModel(reg.id, seed.id);
      const free = isFree(reg.id, seed.id);
      scored.push({ candidate, score: scoreCandidate(intent, caps, health, free) });
    }
  }

  scored.sort((a, b) => b.score - a.score || (a.candidate < b.candidate ? -1 : 1));
  // Interleave per-provider queues (best-first within each provider) so the
  // capped list keeps provider diversity: round 0 = each provider's best,
  // round 1 = each provider's second, and so on.
  const queues = new Map();
  const headScore = new Map();
  for (const s of scored) {
    const provider = s.candidate.slice(0, s.candidate.indexOf("/"));
    const q = queues.get(provider) || [];
    if (q.length === 0) headScore.set(provider, s.score);
    if (q.length < AUTO_PER_PROVIDER_LIMIT) q.push(s.candidate);
    queues.set(provider, q);
  }
  // Queues ordered by their best candidate's score, so round 0 still honours
  // the global ranking while later rounds add provider diversity.
  const ordered = [...queues.values()].sort(
    (a, b) => headScore.get(providerOf(b[0])) - headScore.get(providerOf(a[0])),
  );
  const seen = new Set();
  const out = [];
  let round = 0;
  let progressed = true;
  while (out.length < AUTO_CANDIDATE_LIMIT && progressed) {
    progressed = false;
    for (const q of ordered) {
      if (out.length >= AUTO_CANDIDATE_LIMIT) break;
      const candidate = q[round];
      if (candidate && !seen.has(candidate)) {
        seen.add(candidate);
        out.push(candidate);
        progressed = true;
      }
    }
    round += 1;
  }
  return out;
}
