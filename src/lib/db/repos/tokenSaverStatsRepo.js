// Token Saver savings stats (9Router Pro) — persists RTK compression
// results that chatCore previously only wrote to the console log.
//   scope "tokenSaverStats": key "YYYY-MM-DD" (UTC) →
//     { requests, bytesBefore, bytesAfter, hits,
//       filters: { <filterName>: { hits, saved } } }
// Records are buffered in memory and flushed in batches so the chat hot
// path never pays a DB write per request; a flush also happens on read.
import { makeKv } from "../helpers/kvStore.js";

const kv = makeKv("tokenSaverStats");
const FLUSH_EVERY = 20;
const FLUSH_DELAY_MS = 30_000;

let buffer = [];
let flushTimer = null;
let flushing = false;

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function emptyDay() {
  return { requests: 0, bytesBefore: 0, bytesAfter: 0, hits: 0, filters: {} };
}

// Pure merge — unit-tested.
export function mergeDayStats(day, rec) {
  const out = day && typeof day === "object" ? { ...emptyDay(), ...day, filters: { ...(day.filters || {}) } } : emptyDay();
  out.requests += 1;
  out.bytesBefore += rec.bytesBefore || 0;
  out.bytesAfter += rec.bytesAfter || 0;
  for (const h of rec.hits || []) {
    out.hits += 1;
    const name = h.filter || "unknown";
    const f = out.filters[name] || { hits: 0, saved: 0 };
    f.hits += 1;
    f.saved += h.saved || 0;
    out.filters[name] = f;
  }
  return out;
}

export function recordRtkSavings(stats) {
  if (!stats || !Array.isArray(stats.hits) || stats.hits.length === 0) return;
  buffer.push({
    at: Date.now(),
    bytesBefore: stats.bytesBefore || 0,
    bytesAfter: stats.bytesAfter || 0,
    hits: stats.hits.map((h) => ({ filter: h.filter, saved: h.saved })),
  });
  if (buffer.length >= FLUSH_EVERY) {
    flushTokenSaverStats().catch(() => {});
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => { flushTimer = null; flushTokenSaverStats().catch(() => {}); }, FLUSH_DELAY_MS);
    flushTimer.unref?.();
  }
}

export async function flushTokenSaverStats() {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  const batch = buffer;
  buffer = [];
  try {
    const byDay = new Map();
    for (const rec of batch) {
      const key = dayKey(rec.at);
      const cur = byDay.has(key) ? byDay.get(key) : await kv.get(key);
      byDay.set(key, mergeDayStats(cur, rec));
    }
    for (const [key, val] of byDay) await kv.set(key, val);
  } catch {
    // Stats are best-effort; drop the batch rather than retry forever.
  } finally {
    flushing = false;
  }
}

export async function getTokenSaverStats(days = 14) {
  await flushTokenSaverStats();
  const out = [];
  const now = Date.now();
  for (let i = days - 1; i >= 0; i--) {
    const key = dayKey(now - i * 86_400_000);
    const v = await kv.get(key);
    out.push({ date: key, ...(v && typeof v === "object" ? v : emptyDay()) });
  }
  const totals = emptyDay();
  for (const d of out) {
    totals.requests += d.requests || 0;
    totals.bytesBefore += d.bytesBefore || 0;
    totals.bytesAfter += d.bytesAfter || 0;
    totals.hits += d.hits || 0;
    for (const [name, f] of Object.entries(d.filters || {})) {
      const t = totals.filters[name] || { hits: 0, saved: 0 };
      t.hits += f.hits || 0;
      t.saved += f.saved || 0;
      totals.filters[name] = t;
    }
  }
  const topFilters = Object.entries(totals.filters)
    .map(([name, f]) => ({ name, hits: f.hits, saved: f.saved }))
    .sort((a, b) => b.saved - a.saved)
    .slice(0, 6);
  return { days: out, totals, topFilters };
}
