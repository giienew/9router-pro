// Soul Prompts (9Router Pro) — system prompts with a deliberately flat,
// seren-simple shape but three scopes:
//   · GLOBAL — one soul for the whole router (its SOUL.md)
//   · USER   — one soul per API key (whoever holds the key gets the persona)
//   · MODEL  — one soul per model (combo / alias / provider-model name)
// Every target owns exactly ONE prompt — no profile library, no binding
// step. A request receives at most three: global → user → model.
//
//   scope "soulPrompts": key "global"  → entry
//                        key "byKey"   → { [apiKeyId]: entry }
//                        key "prompts" → { [modelName]: entry }
//   entry = { content, position: "append"|"prepend", enabled, updatedAt }
//
// Model lookup: the name the client called → resolved "provider/model" →
// bare model name. First enabled, non-empty hit wins per scope.

import { makeKv } from "../helpers/kvStore.js";

const kv = makeKv("soulPrompts");
const GLOBAL_KEY = "global";
const BYKEY_KEY = "byKey";
const MODELS_KEY = "prompts";

function cleanEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const content = typeof raw.content === "string" ? raw.content : "";
  if (!content.trim()) return null;
  return {
    content,
    position: raw.position === "prepend" ? "prepend" : "append",
    enabled: raw.enabled !== false,
    updatedAt: raw.updatedAt || null,
  };
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
    content: input.content,
    position: input.position,
    enabled: input.enabled,
    updatedAt: new Date().toISOString(),
  });
}

// --------------------------------------------------------------- global

export async function getSoulGlobal() {
  return cleanEntry(await kv.get(GLOBAL_KEY, null));
}

export async function setSoulGlobal(input = {}) {
  const entry = stamp(input);
  if (!entry) await kv.remove(GLOBAL_KEY);
  else await kv.set(GLOBAL_KEY, entry);
  invalidateSoulSnapshot();
  return entry;
}

// --------------------------------------------------------------- per model

export async function getSoulPrompts() {
  return cleanMap(await kv.get(MODELS_KEY, null));
}

export async function setSoulPrompt(model, input = {}) {
  const name = typeof model === "string" ? model.trim() : "";
  if (!name) return null;
  const map = await getSoulPrompts();
  const entry = stamp(input);
  if (!entry) delete map[name];
  else map[name] = entry;
  await kv.set(MODELS_KEY, map);
  invalidateSoulSnapshot();
  return entry;
}

export async function deleteSoulPrompt(model) {
  const map = await getSoulPrompts();
  if (!(model in map)) return false;
  delete map[model];
  await kv.set(MODELS_KEY, map);
  invalidateSoulSnapshot();
  return true;
}

// --------------------------------------------------------------- per user (API key)

export async function getSoulUserPrompts() {
  return cleanMap(await kv.get(BYKEY_KEY, null));
}

export async function setSoulUserPrompt(keyId, input = {}) {
  const id = typeof keyId === "string" ? keyId.trim() : "";
  if (!id) return null;
  const map = await getSoulUserPrompts();
  const entry = stamp(input);
  if (!entry) delete map[id];
  else map[id] = entry;
  await kv.set(BYKEY_KEY, map);
  invalidateSoulSnapshot();
  return entry;
}

export async function deleteSoulUserPrompt(keyId) {
  const map = await getSoulUserPrompts();
  if (!(keyId in map)) return false;
  delete map[keyId];
  await kv.set(BYKEY_KEY, map);
  invalidateSoulSnapshot();
  return true;
}

// --------------------------------------------------------------- resolver

// Pure selection — exported for tests. Ordered: global → user → model.
export function selectSoulPrompt({ global, byKey, byModel } = {}, ctx = {}) {
  const out = [];
  const g = cleanEntry(global);
  if (g && g.enabled) out.push({ name: "global", text: g.content, position: g.position });

  if (ctx.apiKeyId) {
    const u = cleanMap(byKey)[ctx.apiKeyId];
    if (u && u.enabled) out.push({ name: "user", text: u.content, position: u.position });
  }

  const models = cleanMap(byModel);
  const names = [ctx.requestedModel, ctx.resolvedModel, ctx.bareModel]
    .filter((x) => typeof x === "string" && x);
  for (const name of names) {
    const entry = models[name];
    if (entry && entry.enabled) {
      out.push({ name, text: entry.content, position: entry.position });
      break;
    }
  }
  return out;
}

// --------------------------------------------------------------- snapshot
// Hot-path cache: 3s TTL, every write above invalidates immediately.

const SNAPSHOT_TTL_MS = 3000;
let snapshot = null;

function invalidateSoulSnapshot() {
  snapshot = null;
}

async function getSoulSnapshot() {
  if (snapshot && Date.now() - snapshot.at < SNAPSHOT_TTL_MS) return snapshot;
  const [global, byKey, byModel] = await Promise.all([
    getSoulGlobal(),
    getSoulUserPrompts(),
    getSoulPrompts(),
  ]);
  snapshot = { at: Date.now(), global, byKey, byModel };
  return snapshot;
}

// Resolve the soul prompts for one request (global → user → model).
// Fail-open.
export async function resolveSoulPrompt(ctx = {}) {
  try {
    const snap = await getSoulSnapshot();
    return selectSoulPrompt(snap, ctx);
  } catch {
    return [];
  }
}
