import os from "node:os";
import { execFileSync } from "node:child_process";
import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getLatencyStats } from "@/lib/latencyStats.js";
import { getUsageStats } from "@/lib/usageDb";
import {
  getProviderConnections,
  getProxyPools,
  getApiKeys,
  getCombos,
  getProviderNodes,
} from "@/lib/localDb";
import { getProviderBreakerSnapshot } from "@/sse/services/providerBreaker.js";
import { AI_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers";

export const dynamic = "force-dynamic";

// Short cache like the stats/latency routes: the monitoring page mounts
// twice under StrictMode and the stats build scans rollups + history.
const CACHE_TTL_MS = 5000;
let cache = null;

function getDisk() {
  try {
    const out = execFileSync("df", ["-k", "/"], { encoding: "utf8", timeout: 5000 });
    const parts = out.trim().split("\n").pop().trim().split(/\s+/);
    const totalKb = Number(parts[1]);
    const usedKb = Number(parts[2]);
    const availKb = Number(parts[3]);
    if (!Number.isFinite(totalKb) || !totalKb) return null;
    return { totalBytes: totalKb * 1024, usedBytes: usedKb * 1024, availBytes: availKb * 1024 };
  } catch {
    return null;
  }
}

function countProxies(pools) {
  let n = 0;
  for (const pool of pools || []) {
    const url = pool?.proxyUrl || pool?.data?.proxyUrl || "";
    if (typeof url !== "string") continue;
    n += url.split(/[\s,;]+/).filter(Boolean).length;
  }
  return n;
}

export async function GET() {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return NextResponse.json(cache.data, { headers: { "Cache-Control": "no-store" } });
  }
  try {
    const since7d = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

    let system = null;
    try {
      const cpus = os.cpus() || [];
      system = {
        cpuModel: (cpus[0]?.model || "").replace(/\s+/g, " ").trim() || null,
        cpuCores: cpus.length || null,
        load: os.loadavg(),
        memTotalBytes: os.totalmem(),
        memFreeBytes: os.freemem(),
        disk: getDisk(),
        uptimeSec: Math.floor(os.uptime()),
        appUptimeSec: Math.floor(process.uptime()),
        os: `${os.platform()} ${os.arch()}`,
        hostname: os.hostname(),
      };
    } catch {}

    let dbOk = true;
    let connections = [];
    let pools = [];
    let keys = [];
    let combos = [];
    let nodes = [];
    try {
      const adapter = await getAdapter();
      adapter.get("SELECT 1 AS one");
    } catch {
      dbOk = false;
    }
    try { connections = await getProviderConnections(); } catch {}
    try { pools = await getProxyPools({}); } catch {}
    try { keys = await getApiKeys(); } catch {}
    try { combos = await getCombos(); } catch {}
    try { nodes = await getProviderNodes(); } catch {}

    const providerNames = {};
    for (const node of nodes) if (node.id && node.name) providerNames[node.id] = node.name;
    const resolveName = (id) => {
      if (providerNames[id]) return providerNames[id];
      const cfg = getProviderByAlias(id) || AI_PROVIDERS[id];
      return cfg?.name || id;
    };

    let fastest = null;
    try {
      const db = await getAdapter();
      const latency = await getLatencyStats(db, since7d);
      const entries = Object.entries(latency?.byProvider || {})
        .map(([id, v]) => ({ id, samples: v.samples || 0, p50: v.totalP50 }))
        .filter((e) => Number.isFinite(e.p50) && e.samples > 0);
      const reliable = entries.filter((e) => e.samples >= 5);
      const pool = reliable.length ? reliable : entries;
      pool.sort((a, b) => a.p50 - b.p50);
      if (pool.length) {
        fastest = { id: pool[0].id, name: resolveName(pool[0].id), p50Ms: Math.round(pool[0].p50), samples: pool[0].samples };
      }
    } catch {}

    let mostUsed = null;
    let mostUsedKey = null;
    try {
      const usage = await getUsageStats("7d");
      const entries = Object.entries(usage?.byProvider || {})
        .map(([id, d]) => ({
          id,
          requests: d.requests || 0,
          tokens: (d.promptTokens || 0) + (d.completionTokens || 0),
        }))
        .filter((e) => e.requests > 0);
      entries.sort((a, b) => b.requests - a.requests);
      if (entries.length) {
        mostUsed = {
          id: entries[0].id,
          name: resolveName(entries[0].id),
          requests: entries[0].requests,
          tokens: entries[0].tokens,
          sharePct: usage.totalRequests ? Math.round((entries[0].requests / usage.totalRequests) * 100) : null,
        };
      }
      // Most-used API key: name + masked id only — a raw key value must
      // never leave the server (usage stats already mask it). Local
      // no-key traffic is not a key, so it is excluded.
      const keyEntries = Object.values(usage?.byApiKey || {})
        .map((d) => ({
          name: d.keyName || d.apiKeyMasked || null,
          provider: d.provider || null,
          requests: d.requests || 0,
          tokens: (d.promptTokens || 0) + (d.completionTokens || 0),
          isLocal: d.apiKeyKey === "local-no-key",
        }))
        .filter((e) => e.requests > 0 && !e.isLocal && e.name);
      keyEntries.sort((a, b) => b.requests - a.requests);
      if (keyEntries.length) {
        mostUsedKey = {
          name: keyEntries[0].name,
          provider: keyEntries[0].provider,
          requests: keyEntries[0].requests,
          tokens: keyEntries[0].tokens,
          sharePct: usage.totalRequests ? Math.round((keyEntries[0].requests / usage.totalRequests) * 100) : null,
        };
      }
    } catch {}

    // Provider with the most API keys (opt83): count providerConnections
    // per provider from the already-loaded list — no new DB query. Only
    // counts leave the server (names + numbers, never key values).
    let mostKeys = null;
    try {
      const byProvider = new Map();
      for (const c of connections) {
        const id = c?.provider || "unknown";
        const entry = byProvider.get(id) || { id, total: 0, active: 0 };
        entry.total += 1;
        if (c.isActive !== false) entry.active += 1;
        byProvider.set(id, entry);
      }
      const ranked = [...byProvider.values()].sort((a, b) => b.total - a.total);
      if (ranked.length && ranked[0].total > 0) {
        mostKeys = {
          id: ranked[0].id,
          name: resolveName(ranked[0].id),
          total: ranked[0].total,
          active: ranked[0].active,
          sharePct: connections.length ? Math.round((ranked[0].total / connections.length) * 100) : null,
        };
      }
    } catch {}

    let breakersOpen = 0;
    try {
      for (const b of Object.values(getProviderBreakerSnapshot())) {
        if (b.state === "open") breakersOpen += 1;
      }
    } catch {}

    const data = {
      system,
      providers: {
        total: connections.length,
        active: connections.filter((c) => c.isActive !== false).length,
      },
      proxies: {
        pools: pools.length,
        activePools: pools.filter((p) => p.isActive === true).length,
        totalProxies: countProxies(pools),
      },
      combos: { total: combos.length },
      keys: { total: keys.length },
      fastest,
      mostUsed,
      mostUsedKey,
      mostKeys,
      providerNames,
      health: { db: dbOk ? "ok" : "error", breakersOpen },
    };
    cache = { ts: Date.now(), data };
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}
