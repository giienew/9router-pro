// Provider health summary for the dashboard (G10/G11, API fields only).
// Aggregates per-connection health from the stored connection rows — no
// new dashboard page, no credential fields, no key material.
//
// Health tier mapping (from connectionHealthTier in
// open-sse/services/accountFallback.js, which returns 0|1):
//   * "clean" — no failure recorded (backoffLevel 0 and no lastError).
//   * "suspect" — tier 1: a recent failure (lastErrorAt inside the
//     SUSPECT_PROBATION_MS window, or no lastErrorAt to age from).
//   * "probation" — tier 0 WITH a recorded failure: the failure aged past
//     the probation window, so the connection is eligible to heal on its
//     next success but is still flagged until then. This is the third
//     state the tier function implies but never names; the mapping is
//     stated here so the frontend renders it deliberately, not by guess.
//
// Quarantine exposure: a connection row carries quarantinedAt +
// quarantineReason when auth.js auto-quarantined it (5 consecutive auth
// failures); both fields are surfaced verbatim for quarantined rows and
// null otherwise. Connection ids and names are included because the
// dashboard already lists them on the providers page — the summary is
// dashboard-gated, not a public endpoint.
import { getProviderConnections } from "@/lib/localDb";
import { connectionHealthTier } from "open-sse/services/accountFallback.js";
import { SUSPECT_PROBATION_MS } from "open-sse/config/errorConfig.js";

export function healthTierName(connection, now = Date.now()) {
  const tier = connectionHealthTier(connection, now, SUSPECT_PROBATION_MS);
  if (tier === 1) return "suspect";
  const failed = (connection?.backoffLevel || 0) > 0 || !!connection?.lastError;
  return failed ? "probation" : "clean";
}

export async function getProviderHealthSummary() {
  const connections = await getProviderConnections();
  const now = Date.now();
  const byProvider = {};
  const rows = [];
  let total = 0;
  let clean = 0;
  let suspect = 0;
  let probation = 0;
  let quarantined = 0;

  for (const c of connections) {
    const tier = healthTierName(c, now);
    const isQuarantined = Boolean(c.quarantinedAt);
    total += 1;
    if (tier === "clean") clean += 1;
    else if (tier === "suspect") suspect += 1;
    else probation += 1;
    if (isQuarantined) quarantined += 1;

    const agg = (byProvider[c.provider] ||= { total: 0, clean: 0, suspect: 0, probation: 0, quarantined: 0 });
    agg.total += 1;
    agg[tier] += 1;
    if (isQuarantined) agg.quarantined += 1;

    rows.push({
      connectionId: c.id,
      name: c.name || null,
      provider: c.provider,
      isActive: c.isActive !== false,
      tier,
      quarantined: isQuarantined,
      quarantineReason: c.quarantineReason || null,
      quarantinedAt: c.quarantinedAt || null,
      lastError: c.lastError || null,
    });
  }

  return {
    totals: { total, clean, suspect, probation, quarantined },
    byProvider,
    connections: rows,
  };
}
