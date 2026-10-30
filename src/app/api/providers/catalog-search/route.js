import { NextResponse } from "next/server";
import { FILTERS } from "../suggested-models/filters.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import REGISTRY from "open-sse/providers/registry/index.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

export const dynamic = "force-dynamic";

// GET /api/providers/catalog-search — R10 cross-provider live catalog
// search (also the P3-30 "live catalog import" item, implemented once,
// here). Sources, in order, WITHOUT duplicating the per-provider feed:
//   1. the existing per-provider suggested-models feeds (same FILTERS
//      normalization the provider pages use, fetched server-side);
//   2. registry seeds ONLY for providers with no live feed.
// Capabilities (context, vision, reasoning) come from Pro's existing
// capabilities data. Price is known only where the feed carries pricing
// (OpenRouter); a maxPrice filter excludes unknown-price entries.
// Import reuses POST /api/models/custom — the registry Pro already uses.
let cache = null;
let cacheAt = 0;

async function fetchFeed(url, type) {
  const filter = FILTERS[type];
  if (!filter || !url) return [];
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return [];
    const json = await res.json();
    const raw = json.data ?? json.models ?? json;
    const arr = Array.isArray(raw) ? raw : typeof raw === "object" && raw !== null ? [raw] : [];
    const priceById = new Map();
    for (const m of arr) {
      if (m?.id && m?.pricing && (m.pricing.prompt !== undefined || m.pricing.completion !== undefined)) {
        priceById.set(m.id, { prompt: Number(m.pricing.prompt) || 0, completion: Number(m.pricing.completion) || 0 });
      }
    }
    const normalized = filter(arr);
    return normalized.map((m) => ({ ...m, price: priceById.get(m.id) || null }));
  } catch { return []; }
}

async function buildCatalog() {
  if (cache && Date.now() - cacheAt < 60000) return cache;
  const entries = [];
  const seen = new Set();
  const feedProviders = new Set();
  const jobs = [];
  for (const [key, info] of Object.entries(AI_PROVIDERS)) {
    const fetcher = info?.modelsFetcher;
    if (!fetcher?.url || !fetcher?.type) continue;
    feedProviders.add(key);
    jobs.push((async () => {
      const models = await fetchFeed(fetcher.url, fetcher.type);
      for (const m of models) {
        const id = `${key}/${m.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        let caps = {};
        try { caps = getCapabilitiesForModel(key, m.id) || {}; } catch {}
        entries.push({
          provider: key,
          providerName: info?.name || key,
          id: m.id,
          fullId: id,
          name: m.name || m.id,
          contextLength: m.contextLength || caps.contextWindow || null,
          price: m.price || null,
          vision: !!caps.vision,
          reasoning: !!caps.reasoning,
          source: "live-feed",
        });
      }
    })());
  }
  await Promise.all(jobs);
  // Registry seeds only where no live feed exists — no feed duplication.
  for (const reg of REGISTRY) {
    if (feedProviders.has(reg.id) || !Array.isArray(reg.models)) continue;
    for (const seed of reg.models) {
      if (!seed?.id) continue;
      const id = `${reg.id}/${seed.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      let caps = {};
      try { caps = getCapabilitiesForModel(reg.id, seed.id) || {}; } catch {}
      entries.push({
        provider: reg.id, providerName: reg.name || reg.id, id: seed.id, fullId: id,
        name: seed.name || seed.id, contextLength: caps.contextWindow || null,
        price: null, vision: !!caps.vision, reasoning: !!caps.reasoning, source: "registry",
      });
    }
  }
  cache = entries;
  cacheAt = Date.now();
  return entries;
}

export async function GET(request) {
  try {
    const p = new URL(request.url).searchParams;
    const q = (p.get("q") || "").trim().toLowerCase();
    const provider = p.get("provider") || "";
    const minContext = Number(p.get("minContext")) || 0;
    const maxPrice = p.get("maxPrice") ? Number(p.get("maxPrice")) : null;
    const vision = p.get("vision") === "1";
    const reasoning = p.get("reasoning") === "1";
    const limit = Math.min(200, Math.max(1, Number(p.get("limit")) || 50));
    let entries = await buildCatalog();
    entries = entries.filter((e) => {
      if (provider && e.provider !== provider) return false;
      if (q && !(e.id.toLowerCase().includes(q) || (e.name || "").toLowerCase().includes(q) || e.provider.toLowerCase().includes(q))) return false;
      if (minContext && !(e.contextLength && e.contextLength >= minContext)) return false;
      if (maxPrice != null) {
        if (!e.price) return false;
        if (Math.max(e.price.prompt, e.price.completion) > maxPrice) return false;
      }
      if (vision && !e.vision) return false;
      if (reasoning && !e.reasoning) return false;
      return true;
    });
    entries.sort((a, b) => {
      const aq = q && a.id.toLowerCase().startsWith(q) ? 1 : 0;
      const bq = q && b.id.toLowerCase().startsWith(q) ? 1 : 0;
      if (aq !== bq) return bq - aq;
      return (b.contextLength || 0) - (a.contextLength || 0);
    });
    return NextResponse.json({ models: entries.slice(0, limit), total: entries.length, sources: ["live-feed", "registry"] }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}
