// Combo advisor (R1/R4, 9Router Pro, original code) — pure ranking only.
// The route supplies candidates built from the user's OWN active
// connections + the registry seeds; nothing here touches shared pools or
// writes to SQLite directly. R1 = maintained free stack (dry-run first,
// watchdog refreshes the draft); R4 = one-time tiered proposal. Both
// drafts are NOT applied until the user approves (POST apply:true).

// Chat-only heuristic: registry seeds for image/TTS/embeddings/audio
// lanes are not chat models. Capability data refines this in the route;
// the id heuristic is the documented fallback for uncatalogued seeds.
const NON_CHAT_RE = /(image|tts|text-to-speech|embed|audio|video|speech|whisper|flux|stable-diffusion)/i;
export function isChatModelId(id) {
  if (typeof id !== "string" || !id.includes("/")) return false;
  return !NON_CHAT_RE.test(id);
}

export function isFreeModel(providerId, modelId, freeProviders = {}) {
  if (freeProviders && Object.prototype.hasOwnProperty.call(freeProviders, providerId)) return true;
  return typeof modelId === "string" && modelId.endsWith(":free");
}

export function bareModelId(fullId) {
  const slash = fullId.lastIndexOf("/");
  return slash >= 0 ? fullId.slice(slash + 1) : fullId;
}

// Dedupe the same model across duplicate accounts: keep the healthiest,
// then lowest-latency, provider of the winner.
export function dedupeCandidates(candidates = []) {
  const byBare = new Map();
  for (const c of candidates) {
    const bare = bareModelId(c.id);
    const prev = byBare.get(bare);
    if (!prev) { byBare.set(bare, c); continue; }
    const better = (c.healthy ? 1 : 0) - (prev.healthy ? 1 : 0)
      || (prev.latencyMs ?? Infinity) - (c.latencyMs ?? Infinity);
    if (better > 0) byBare.set(bare, c);
  }
  return [...byBare.values()];
}

export function scoreFreeCandidate(c) {
  let s = 0;
  if (c.free) s += 100;
  if (c.healthy) s += 50;
  if (c.latencyMs != null) s += Math.max(0, 30 - Math.round(c.latencyMs / 100));
  if (c.contextWindow) s += Math.min(20, Math.round(10 * Math.log10(Math.max(1000, c.contextWindow) / 1000)));
  return s;
}

export function rankFreeCandidates(candidates = []) {
  return dedupeCandidates(candidates)
    .map((c) => ({ ...c, score: scoreFreeCandidate(c) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

// R1: ranked free stack. Rate-limited models are parked in `holding`
// (a cooldown holding combo), never in the live stack.
export function buildFreeStack(candidates = [], limit = 5) {
  const ranked = rankFreeCandidates(candidates);
  const live = ranked.filter((c) => !c.rateLimited && c.free);
  const holding = ranked.filter((c) => c.rateLimited);
  return {
    members: live.slice(0, limit).map((c) => c.id),
    holding: holding.map((c) => c.id),
    ranked: ranked.slice(0, limit + holding.length),
  };
}

// R4: one member per tier — quality (reasoning+tools, big context),
// fast (lowest measured latency, else small context), free.
export function buildTieredDraft(candidates = []) {
  const pool = dedupeCandidates(candidates).filter((c) => c.healthy !== false);
  const used = new Set();
  const pick = (sortFn) => {
    const rest = pool.filter((c) => !used.has(c.id)).sort(sortFn);
    const winner = rest[0];
    if (winner) used.add(winner.id);
    return winner?.id || null;
  };
  const quality = pick((a, b) =>
    ((b.reasoning ? 20 : 0) + (b.tools ? 30 : 0) + Math.min(40, Math.round(10 * Math.log10(Math.max(1000, b.contextWindow || 1000) / 1000))))
    - ((a.reasoning ? 20 : 0) + (a.tools ? 30 : 0) + Math.min(40, Math.round(10 * Math.log10(Math.max(1000, a.contextWindow || 1000) / 1000)))));
  const fast = pick((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity) || (a.contextWindow || 0) - (b.contextWindow || 0));
  const free = pick((a, b) => (b.free ? 1 : 0) - (a.free ? 1 : 0) || (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity));
  return { tiers: { quality, fast, free }, members: [quality, fast, free].filter(Boolean) };
}

export function dryRunPreview({ draft, existingCombos = [], proposedName }) {
  const existing = new Set((existingCombos || []).map((c) => c.name));
  const wouldCreate = !existing.has(proposedName);
  return {
    proposedName,
    members: draft.members || [],
    holding: draft.holding || [],
    tiers: draft.tiers || null,
    wouldCreate,
    skippedAsExisting: wouldCreate ? [] : [proposedName],
    changes: wouldCreate
      ? [`Create combo "${proposedName}" with ${(draft.members || []).length} member(s)`]
      : [`Combo "${proposedName}" already exists — nothing will be created`],
  };
}
