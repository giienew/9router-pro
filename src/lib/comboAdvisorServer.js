// Server-side candidate builder for the combo advisor (R1/R4).
// Candidates come ONLY from the user's own active provider connections
// plus registry seeds for those providers — never shared pools, never
// direct SQLite writes from a tool. Health = stored testStatus, optionally
// refreshed by a bounded live probe (testSingleConnection, the same path
// the Providers Test button uses, at most 3 providers).
import REGISTRY from "open-sse/providers/registry/index.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { getProviderConnections } from "@/lib/localDb";
import { getAdapter } from "@/lib/db/driver.js";
import { getLatencyStats } from "@/lib/latencyStats.js";
import { FREE_PROVIDERS } from "@/shared/constants/providers";
import { isChatModelId, isFreeModel, buildFreeStack, buildTieredDraft, dryRunPreview } from "@/lib/comboAdvisor.js";

const MODEL_LOCK_PREFIX = "modelLock_";

function providerHealth(conns) {
  let healthy = false;
  let rateLimited = false;
  let bestId = null;
  const now = Date.now();
  for (const c of conns) {
    const spec = c.providerSpecificData || {};
    const status = spec.testStatus;
    if (status === "active" || status === "success") healthy = true;
    if (spec.rateLimitedUntil && new Date(spec.rateLimitedUntil).getTime() > now) rateLimited = true;
    if (Object.entries(spec).some(([k, v]) => k.startsWith(MODEL_LOCK_PREFIX) && v && new Date(v).getTime() > now)) rateLimited = true;
    if (!bestId) bestId = c.id;
  }
  return { healthy, rateLimited, bestId };
}

export async function buildAdvisorCandidates({ probe = false } = {}) {
  const connections = (await getProviderConnections()).filter((c) => c.isActive !== false);
  const byProvider = new Map();
  for (const c of connections) {
    if (!byProvider.has(c.provider)) byProvider.set(c.provider, []);
    byProvider.get(c.provider).push(c);
  }
  let latencyByProvider = {};
  try {
    const db = await getAdapter();
    const stats = await getLatencyStats(db, new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString());
    for (const [p, v] of Object.entries(stats.byProvider || {})) latencyByProvider[p] = v.totalP50 ?? null;
  } catch {}

  const candidates = [];
  for (const reg of REGISTRY) {
    const conns = byProvider.get(reg.id);
    if (!conns || !Array.isArray(reg.models)) continue;
    const health = providerHealth(conns);
    for (const seed of reg.models) {
      if (!seed?.id) continue;
      const id = `${reg.id}/${seed.id}`;
      if (!isChatModelId(id)) continue;
      let caps = {};
      try { caps = getCapabilitiesForModel(reg.id, seed.id) || {}; } catch {}
      candidates.push({
        id,
        provider: reg.id,
        free: isFreeModel(reg.id, seed.id, FREE_PROVIDERS),
        healthy: health.healthy,
        rateLimited: health.rateLimited,
        latencyMs: latencyByProvider[reg.id] ?? null,
        contextWindow: caps.contextWindow || seed.contextWindow || null,
        tools: !!caps.tools,
        reasoning: !!caps.reasoning,
      });
    }
  }

  let probed = [];
  if (probe) {
    try {
      const { testSingleConnection } = await import("@/app/api/providers/[id]/test/testUtils.js");
      const providers = [...new Set(candidates.map((c) => c.provider))].slice(0, 3);
      for (const p of providers) {
        const health = providerHealth(byProvider.get(p));
        if (!health.bestId) continue;
        const res = await testSingleConnection(health.bestId).catch(() => null);
        if (res) probed.push({ provider: p, valid: !!res.valid, latencyMs: res.latencyMs || null });
        if (res?.valid) {
          for (const c of candidates) if (c.provider === p) { c.healthy = true; if (res.latencyMs) c.latencyMs = res.latencyMs; }
        }
      }
    } catch {}
  }
  return { candidates, probed, providers: [...byProvider.keys()] };
}

export function buildAdvisorDraft(candidates, mode) {
  if (mode === "tiered") return buildTieredDraft(candidates);
  const stack = buildFreeStack(candidates);
  return { members: stack.members, holding: stack.holding, ranked: stack.ranked };
}

export function previewAdvisorDraft({ candidates, mode, existingCombos, proposedName }) {
  const draft = buildAdvisorDraft(candidates, mode);
  return { draft, preview: dryRunPreview({ draft, existingCombos, proposedName }) };
}
