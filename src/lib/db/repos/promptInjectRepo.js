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
const presetsKv = makeKv("promptPresets");
const GLOBAL_KEY = "global";
const BYKEY_KEY = "byKey";
const MODELS_KEY = "prompts";
const PRESETS_KEY = "list";
const MAX_TURNS = 50;
const MAX_PRESET_TARGETS = 300;

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

// --------------------------------------------------------------- presets
// A preset is a reusable USER-scope injection (same entry shape) with
// targets: it fires globally and/or for chosen API keys — never on
// models (per-model prompts live in the direct model injections; one
// concern, one place). In the stack a preset fires at most ONCE per
// request, at the earliest scope it targets (global → user), ahead of
// that scope's direct entry.
//   scope "promptPresets": key "list" → [preset]
//   preset = { id, name, mode, content, turns, position, enabled,
//              targets: { global, keys: [] }, updatedAt }

function cleanTargetNames(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const x of raw) {
    if (typeof x !== "string") continue;
    const v = x.trim();
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= MAX_PRESET_TARGETS) break;
  }
  return out;
}

export function cleanPreset(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 80) : "";
  if (!id || !name) return null;
  const entry = cleanEntry(raw);
  if (!entry) return null;
  const t = raw.targets && typeof raw.targets === "object" ? raw.targets : {};
  return {
    id,
    name,
    ...entry,
    targets: {
      global: !!t.global,
      keys: cleanTargetNames(t.keys),
    },
  };
}

function cleanPresetList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const p of raw) {
    const clean = cleanPreset(p);
    if (clean) out.push(clean);
  }
  return out;
}

export async function getPromptPresets() {
  return cleanPresetList(await presetsKv.get(PRESETS_KEY, null));
}

export async function upsertPromptPreset(input = {}) {
  const list = await getPromptPresets();
  const id =
    typeof input.id === "string" && input.id.trim()
      ? input.id.trim()
      : `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const preset = cleanPreset({ ...input, id, updatedAt: new Date().toISOString() });
  if (!preset) return null;
  const idx = list.findIndex((p) => p.id === id);
  if (idx >= 0) list[idx] = preset;
  else list.push(preset);
  await presetsKv.set(PRESETS_KEY, list);
  invalidateInjectSnapshot();
  return preset;
}

export async function deletePromptPreset(id) {
  const list = await getPromptPresets();
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) return false;
  await presetsKv.set(PRESETS_KEY, next);
  invalidateInjectSnapshot();
  return true;
}

// --------------------------------------------------------------- resolver

// Pure selection — exported for tests. Ordered: global → user → model.
// Presets fire at the global/user scopes only, ahead of the scope's
// direct entry; the model scope carries direct entries only.
export function selectPromptInjections({ global, byKey, byModel, presets } = {}, ctx = {}) {
  const out = [];
  const push = (name, e) => {
    if (!e || !e.enabled) return;
    if (e.mode === "chat") out.push({ name, mode: "chat", turns: e.turns, position: e.position });
    else out.push({ name, mode: "single", text: e.content, position: e.position });
  };

  const presetList = cleanPresetList(presets);
  const fired = new Set();
  const pushPreset = (p) => {
    if (fired.has(p.id)) return;
    fired.add(p.id);
    push(`preset:${p.name}`, p);
  };

  for (const p of presetList) if (p.targets.global) pushPreset(p);
  push("global", cleanEntry(global));

  if (ctx.apiKeyId) {
    for (const p of presetList) if (p.targets.keys.includes(ctx.apiKeyId)) pushPreset(p);
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
  const [global, byKey, byModel, presets] = await Promise.all([
    getInjectGlobal(),
    getInjectUserPrompts(),
    getInjectModelPrompts(),
    getPromptPresets(),
  ]);
  snapshot = { at: Date.now(), global, byKey, byModel, presets };
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
