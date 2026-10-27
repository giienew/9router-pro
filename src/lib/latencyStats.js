// Latency statistics (9Router Pro): p50/p95 of TTFT and total time, from
// the request-details records the chat handlers already save (latency.ttft
// / latency.total). No new instrumentation: rows only exist for requests
// served after this feature lands, and periods with no rows report
// samples: 0 instead of fabricated numbers.
export function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

export function computeLatencyStats(rows) {
  const totals = [];
  const ttfts = [];
  const byProvider = {};
  for (const r of rows || []) {
    const total = Number(r.total);
    if (!Number.isFinite(total) || total <= 0) continue;
    totals.push(total);
    const ttft = Number(r.ttft);
    if (Number.isFinite(ttft) && ttft > 0) ttfts.push(ttft);
    const p = r.provider || "unknown";
    if (!byProvider[p]) byProvider[p] = { totals: [], ttfts: [] };
    byProvider[p].totals.push(total);
    if (Number.isFinite(ttft) && ttft > 0) byProvider[p].ttfts.push(ttft);
  }
  totals.sort((a, b) => a - b);
  ttfts.sort((a, b) => a - b);
  const out = {
    samples: totals.length,
    ttft: { samples: ttfts.length, p50: percentile(ttfts, 50), p95: percentile(ttfts, 95) },
    total: { samples: totals.length, p50: percentile(totals, 50), p95: percentile(totals, 95) },
    byProvider: {},
  };
  for (const [provider, v] of Object.entries(byProvider)) {
    v.totals.sort((a, b) => a - b);
    v.ttfts.sort((a, b) => a - b);
    out.byProvider[provider] = {
      samples: v.totals.length,
      totalP50: percentile(v.totals, 50),
      totalP95: percentile(v.totals, 95),
      ttftP50: percentile(v.ttfts, 50),
    };
  }
  return out;
}

export async function getLatencyStats(db, sinceIso = null, limit = 5000) {
  const rows = sinceIso
    ? db.all(`SELECT data FROM requestDetails WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT ?`, [sinceIso, limit])
    : db.all(`SELECT data FROM requestDetails ORDER BY timestamp DESC LIMIT ?`, [limit]);
  const parsed = [];
  for (const row of rows || []) {
    try {
      const d = JSON.parse(row.data);
      const lat = d?.latency || {};
      parsed.push({ provider: d?.provider || "unknown", total: lat.total, ttft: lat.ttft });
    } catch { /* skip corrupt rows */ }
  }
  return computeLatencyStats(parsed);
}
