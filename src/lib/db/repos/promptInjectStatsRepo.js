// Prompt Injection usage stats (9Router Pro) — counts which injections
// actually fire, so a variant's card can show whether its prompt lives
// or is dead. Mirrors tokenSaverStatsRepo: buffered in memory, flushed
// in batches, pruned on read, best-effort throughout — recording must
// never fail a chat request.
//   scope "promptInjectStats": key "YYYY-MM-DD" (UTC) →
//     { requests, byScope: { <scope>: fires },
//       byName: { <coordKey>: { scope, fires } } }
// A fire records ONLY the injection's coordinate key, scope and mode —
// never prompt text. Coordinate keys reuse the dashboard's coordId
// shape: "global", "key:<apiKeyId>", "variant:<name>",
// "model:<model>", "km:<apiKeyId>::<model>".
import { makeKv } from "../helpers/kvStore.js";

const kv = makeKv("promptInjectStats");
const FLUSH_EVERY = 20;
const FLUSH_DELAY_MS = 30_000;
const RETENTION_DAYS = 90;

let buffer = [];
let flushTimer = null;
let flushing = false;

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function emptyDay() {
  return { requests: 0, byScope: {}, byName: {} };
}

// Pure classification of a resolved injection stack into countable fires.
// The stack comes from selectPromptInjections, in stacking order:
// global → key → variant → model+key. Names are the only signal, the
// same signal the Stack Preview UI already shows:
//   "global" → global scope, "user" → the request's API key scope.
//   A bare requested name (no "/") is a variant pick: every remaining
//   entry is that variant (a variant pick suppresses the model scopes).
//   Otherwise the remaining entries are model scopes, in resolver order:
//   the first is the plain model coordinate, later ones are model+key.
//   A lone model-scope entry is ambiguous, so keyModelNames (the
//   request key's model+key map keys, fetched lazily by the caller only
//   in that case) decides it. A variant literally named "global" or
//   "user" would misclassify — the same ambiguity the preview UI has.
export function classifyInjectStack(stack, { apiKeyId = null, requestedModel = "", keyModelNames = null } = {}) {
  if (!Array.isArray(stack) || !stack.length) return [];
  const variantPick =
    typeof requestedModel === "string" && requestedModel && !requestedModel.includes("/");
  const fires = [];
  const modelish = [];
  for (const entry of stack) {
    if (!entry || typeof entry.name !== "string" || !entry.name) continue;
    if (entry.name === "global") {
      fires.push({ key: "global", scope: "global", mode: entry.mode || "single" });
    } else if (entry.name === "user") {
      fires.push({ key: `key:${apiKeyId || "?"}`, scope: "key", mode: entry.mode || "single" });
    } else if (variantPick) {
      fires.push({ key: `variant:${entry.name}`, scope: "variant", mode: entry.mode || "single" });
    } else {
      modelish.push(entry);
    }
  }
  modelish.forEach((entry, i) => {
    let scope = "model";
    if (i > 0) scope = "modelKey";
    else if (keyModelNames && keyModelNames.has(entry.name)) scope = "modelKey";
    const key =
      scope === "modelKey" ? `km:${apiKeyId || "?"}::${entry.name}` : `model:${entry.name}`;
    fires.push({ key, scope, mode: entry.mode || "single" });
  });
  return fires;
}

// Pure merge — unit-testable.
export function mergeDayStats(day, rec) {
  const out = day && typeof day === "object" ? { ...emptyDay(), ...day, byScope: { ...(day.byScope || {}) }, byName: { ...(day.byName || {}) } } : emptyDay();
  out.requests += 1;
  for (const f of rec.fires || []) {
    if (!f || typeof f.key !== "string" || !f.key) continue;
    out.byScope[f.scope || "unknown"] = (out.byScope[f.scope || "unknown"] || 0) + 1;
    const prev = out.byName[f.key] || { scope: f.scope || "unknown", fires: 0 };
    prev.fires += 1;
    out.byName[f.key] = prev;
  }
  return out;
}

export function recordPromptInjectFire(fires) {
  if (!Array.isArray(fires) || fires.length === 0) return;
  buffer.push({ at: Date.now(), fires: fires.map((f) => ({ key: f.key, scope: f.scope })) });
  if (buffer.length >= FLUSH_EVERY) {
    flushPromptInjectStats().catch(() => {});
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => { flushTimer = null; flushPromptInjectStats().catch(() => {}); }, FLUSH_DELAY_MS);
    flushTimer.unref?.();
  }
}

export async function flushPromptInjectStats() {
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

// Retention: the stats API clamps to 90 days, so day-rows older than that
// are never read. Prune them on read (the same place that already
// flushes), so the scope stays bounded without any timer or job.
async function pruneOldDays() {
  try {
    const cutoff = dayKey(Date.now() - RETENTION_DAYS * 86_400_000);
    const all = await kv.getAll();
    const stale = Object.keys(all).filter((k) => k < cutoff);
    for (const k of stale) await kv.remove(k);
  } catch {
    // Best-effort, like the rest of this repo.
  }
}

export async function getPromptInjectStats(days = 14) {
  await flushPromptInjectStats();
  await pruneOldDays();
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
    for (const [scope, n] of Object.entries(d.byScope || {})) {
      totals.byScope[scope] = (totals.byScope[scope] || 0) + n;
    }
    for (const [key, e] of Object.entries(d.byName || {})) {
      const t = totals.byName[key] || { scope: e.scope || "unknown", fires: 0 };
      t.fires += e.fires || 0;
      totals.byName[key] = t;
    }
  }
  return { days: out, totals };
}
