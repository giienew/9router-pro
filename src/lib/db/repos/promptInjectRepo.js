// Prompt Injection (9Router Pro) — injected context with a deliberately
// flat shape but three scopes:
//   · GLOBAL — one injection for the whole router
//   · USER   — one injection per API key (whoever holds the key)
//   · MODEL  — one injection per model (combo / alias / provider-model name)
// Every target owns exactly ONE injection — no profile library, no binding
// step. A request receives at most three, stacked global → user → model.
//
// Each injection is one of two modes:
//   · "single" — one system prompt (position prepend/append into system)
//   · "chat"   — a scripted conversation (user/assistant turns) inserted
//                as fake history right after the system message(s), so the
//                model treats it as something that already happened
//
//   scope "promptInjections": key "global"  → entry
//                             key "byKey"   → { [apiKeyId]: entry }
//                             key "prompts" → { [modelName]: entry }
//   entry = { mode, content, turns: [{ role, content }], position,
//             enabled, updatedAt }
//
// Model lookup: the name the client called → resolved "provider/model" →
// bare model name. First enabled, non-empty hit wins per scope.
// Data written by the earlier "Soul Prompts" build (scope "soulPrompts",
// content-only entries) is migrated on first read and treated as "single".

import { makeKv } from "../helpers/kvStore.js";

const kv = makeKv("promptInjections");
const legacyKv = makeKv("soulPrompts");
const GLOBAL_KEY = "global";
const BYKEY_KEY = "byKey";
const MODELS_KEY = "prompts";
const MAX_TURNS = 50;

function cleanTurns(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const role = t.role === "assistant" ? "assistant" : t.role === "user" ? "user" : null;
    const content = typeof t.content === "string" ? t.content : "";
    if (role && content.trim()) out.push({ role, content });
    if (out.length >= MAX_TURNS) break;
  }
  return out;
}

function cleanEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const base = {
    position: raw.position === "prepend" ? "prepend" : "append",
    enabled: raw.enabled !== false,
    updatedAt: raw.updatedAt || null,
  };
  if (raw.mode === "chat") {
    const turns = cleanTurns(raw.turns);
    if (!turns.length) return null;
    return { mode: "chat", content: "", turns, ...base };
  }
  const content = typeof raw.content === "string" ? raw.content : "";
  if (!content.trim()) return null;
  return { mode: "single", content, turns: [], ...base };
}

function cleanMap(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [name, entry] of Object.entries(raw)) {
    const clean = cleanEntry(entry);
    if (name && clean) out[name] = clean;
  }
  return out;
}

function stamp(input = {}) {
  return cleanEntry({
    mode: input.mode,
    content: input.content,
    turns: input.turns,
    position: input.position,
    enabled: input.enabled,
    updatedAt: new Date().toISOString(),
  });
}

// ------------------------------------------------------------ migration
// One-time copy from the legacy "soulPrompts" scope. Runs lazily on first
// read; a no-op once the new scope holds anything.
let migrated = false;
async function ensureMigrated() {
  if (migrated) return;
  migrated = true;
  try {
    const [g, k, m] = await Promise.all([
      kv.get(GLOBAL_KEY, null), kv.get(BYKEY_KEY, null), kv.get(MODELS_KEY, null),
    ]);
    if (g || k || m) return;
    const [lg, lk, lm] = await Promise.all([
      legacyKv.get(GLOBAL_KEY, null), legacyKv.get(BYKEY_KEY, null), legacyKv.get(MODELS_KEY, null),
    ]);
    if (lg) await kv.set(GLOBAL_KEY, lg);
    if (lk) await kv.set(BYKEY_KEY, lk);
    if (lm) await kv.set(MODELS_KEY, lm);
  } catch { /* fail-open: migration must never break reads */ }
}

// --------------------------------------------------------------- global

export async function getInjectGlobal() {
  await ensureMigrated();
  return cleanEntry(await kv.get(GLOBAL_KEY, null));
}

export async function setInjectGlobal(input = {}) {
  await ensureMigrated();
  const entry = stamp(input);
  if (!entry) await kv.remove(GLOBAL_KEY);
  else await kv.set(GLOBAL_KEY, entry);
  invalidateInjectSnapshot();
  return entry;
}

// --------------------------------------------------------------- per model

export async function getInjectModelPrompts() {
  await ensureMigrated();
  return cleanMap(await kv.get(MODELS_KEY, null));
}

export async function setInjectModelPrompt(model, input = {}) {
  const name = typeof model === "string" ? model.trim() : "";
  if (!name) return null;
  const map = await getInjectModelPrompts();
  const entry = stamp(input);
  if (!entry) delete map[name];
  else map[name] = entry;
  await kv.set(MODELS_KEY, map);
  invalidateInjectSnapshot();
  return entry;
}

export async function deleteInjectModelPrompt(model) {
  const map = await getInjectModelPrompts();
  if (!(model in map)) return false;
  delete map[model];
  await kv.set(MODELS_KEY, map);
  invalidateInjectSnapshot();
  return true;
}

// --------------------------------------------------------------- per user (API key)

export async function getInjectUserPrompts() {
  await ensureMigrated();
  return cleanMap(await kv.get(BYKEY_KEY, null));
}

export async function setInjectUserPrompt(keyId, input = {}) {
  const id = typeof keyId === "string" ? keyId.trim() : "";
  if (!id) return null;
  const map = await getInjectUserPrompts();
  const entry = stamp(input);
  if (!entry) delete map[id];
  else map[id] = entry;
  await kv.set(BYKEY_KEY, map);
  invalidateInjectSnapshot();
  return entry;
}

export async function deleteInjectUserPrompt(keyId) {
  const map = await getInjectUserPrompts();
  if (!(keyId in map)) return false;
  delete map[keyId];
  await kv.set(BYKEY_KEY, map);
  invalidateInjectSnapshot();
  return true;
}

// --------------------------------------------------------------- resolver

// Pure selection — exported for tests. Ordered: global → user → model.
export function selectPromptInjections({ global, byKey, byModel } = {}, ctx = {}) {
  const out = [];
  const push = (name, e) => {
    if (!e || !e.enabled) return;
    if (e.mode === "chat") out.push({ name, mode: "chat", turns: e.turns, position: e.position });
    else out.push({ name, mode: "single", text: e.content, position: e.position });
  };

  push("global", cleanEntry(global));

  if (ctx.apiKeyId) {
    push("user", cleanMap(byKey)[ctx.apiKeyId]);
  }

  const models = cleanMap(byModel);
  const names = [ctx.requestedModel, ctx.resolvedModel, ctx.bareModel]
    .filter((x) => typeof x === "string" && x);
  for (const name of names) {
    const entry = models[name];
    if (entry && entry.enabled) {
      push(name, entry);
      break;
    }
  }
  return out;
}

// --------------------------------------------------------------- snapshot
// Hot-path cache: 3s TTL, every write above invalidates immediately.

const SNAPSHOT_TTL_MS = 3000;
let snapshot = null;

function invalidateInjectSnapshot() {
  snapshot = null;
}

async function getInjectSnapshot() {
  if (snapshot && Date.now() - snapshot.at < SNAPSHOT_TTL_MS) return snapshot;
  const [global, byKey, byModel] = await Promise.all([
    getInjectGlobal(),
    getInjectUserPrompts(),
    getInjectModelPrompts(),
  ]);
  snapshot = { at: Date.now(), global, byKey, byModel };
  return snapshot;
}

// Resolve the injections for one request (global → user → model). Fail-open.
export async function resolvePromptInjections(ctx = {}) {
  try {
    const snap = await getInjectSnapshot();
    return selectPromptInjections(snap, ctx);
  } catch {
    return [];
  }
}
