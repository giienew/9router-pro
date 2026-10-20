// Prompt Inject (9Router Pro) — reusable system-prompt profiles that get
// injected into chat requests, bound globally, per API key, or per model.
//
// Storage follows the upstream KV pattern (see aliasRepo):
//   scope "promptProfiles": key = profile id, value = profile object
//   scope "promptBindings": key = "bindings", value = { global, byKey, byModel }
//
// Profile: { id, name, content, position: "append"|"prepend", enabled,
//            createdAt, updatedAt }
// Bindings: { global: [profileId...],
//             byKey:  { [apiKeyId]: [profileId...] },
//             byModel:{ [modelName]: [profileId...] } }

import { v4 as uuidv4 } from "uuid";
import { makeKv } from "../helpers/kvStore.js";

const profilesKv = makeKv("promptProfiles");
const bindingsKv = makeKv("promptBindings");

const BINDINGS_KEY = "bindings";

function emptyBindings() {
  return { global: [], byKey: {}, byModel: {} };
}

function cleanIdList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const id of list) {
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function cleanBindings(raw) {
  const out = emptyBindings();
  if (!raw || typeof raw !== "object") return out;
  out.global = cleanIdList(raw.global);
  for (const scope of ["byKey", "byModel"]) {
    const src = raw[scope];
    if (!src || typeof src !== "object") continue;
    for (const [k, v] of Object.entries(src)) {
      const ids = cleanIdList(v);
      if (k && ids.length) out[scope][k] = ids;
    }
  }
  return out;
}

function cleanProfile(raw) {
  if (!raw || typeof raw !== "object" || !raw.id) return null;
  return {
    id: String(raw.id),
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "Untitled",
    content: typeof raw.content === "string" ? raw.content : "",
    position: raw.position === "prepend" ? "prepend" : "append",
    enabled: raw.enabled !== false,
    createdAt: raw.createdAt || null,
    updatedAt: raw.updatedAt || null,
  };
}

// --------------------------------------------------------------- profiles

export async function getPromptProfiles() {
  const all = await profilesKv.getAll();
  return Object.values(all)
    .map(cleanProfile)
    .filter(Boolean)
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
}

export async function getPromptProfileById(id) {
  if (!id) return null;
  return cleanProfile(await profilesKv.get(id));
}

export async function createPromptProfile({ name, content, position = "append", enabled = true } = {}) {
  const now = new Date().toISOString();
  const profile = cleanProfile({
    id: uuidv4(),
    name,
    content,
    position,
    enabled: enabled !== false,
    createdAt: now,
    updatedAt: now,
  });
  await profilesKv.set(profile.id, profile);
  invalidatePromptSnapshot();
  return profile;
}

export async function updatePromptProfile(id, patch = {}) {
  const prev = await getPromptProfileById(id);
  if (!prev) return null;
  const next = cleanProfile({
    ...prev,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.content !== undefined ? { content: patch.content } : {}),
    ...(patch.position !== undefined ? { position: patch.position } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    updatedAt: new Date().toISOString(),
  });
  await profilesKv.set(id, next);
  invalidatePromptSnapshot();
  return next;
}

export async function deletePromptProfile(id) {
  if (!id) return false;
  await profilesKv.remove(id);
  // Scrub the id from every binding so resolvers never chase a ghost.
  const bindings = await getPromptBindings();
  bindings.global = bindings.global.filter((x) => x !== id);
  for (const scope of ["byKey", "byModel"]) {
    for (const k of Object.keys(bindings[scope])) {
      bindings[scope][k] = bindings[scope][k].filter((x) => x !== id);
      if (!bindings[scope][k].length) delete bindings[scope][k];
    }
  }
  await bindingsKv.set(BINDINGS_KEY, bindings);
  invalidatePromptSnapshot();
  return true;
}

// --------------------------------------------------------------- bindings

export async function getPromptBindings() {
  return cleanBindings(await bindingsKv.get(BINDINGS_KEY, null));
}

export async function setPromptBindings(bindings) {
  const clean = cleanBindings(bindings);
  await bindingsKv.set(BINDINGS_KEY, clean);
  invalidatePromptSnapshot();
  return clean;
}

// --------------------------------------------------------------- resolver

// Pure selection — exported for tests. Order matters: global first, then
// per-key, then per-model (requested name, then resolved provider/model,
// then bare model). A profile bound at several levels is injected once
// (first binding wins). Disabled profiles and empty contents are skipped.
export function selectPromptInjects(profiles, bindings, ctx = {}) {
  const byId = new Map();
  for (const p of profiles || []) {
    const clean = cleanProfile(p);
    if (clean) byId.set(clean.id, clean);
  }
  const b = cleanBindings(bindings);
  const orderedIds = [];
  const seen = new Set();
  const push = (ids) => {
    for (const id of ids || []) {
      if (seen.has(id)) continue;
      seen.add(id);
      orderedIds.push(id);
    }
  };

  push(b.global);
  if (ctx.apiKeyId) push(b.byKey[ctx.apiKeyId]);
  const modelNames = [ctx.requestedModel, ctx.resolvedModel, ctx.bareModel]
    .filter((x) => typeof x === "string" && x);
  for (const name of modelNames) push(b.byModel[name]);

  const out = [];
  for (const id of orderedIds) {
    const p = byId.get(id);
    if (!p || !p.enabled || !p.content.trim()) continue;
    out.push({ id: p.id, name: p.name, text: p.content, position: p.position });
  }
  return out;
}

// --------------------------------------------------------------- snapshot
// Hot-path cache: chat requests resolve injects on every call, and profiles
// change rarely. A 3s snapshot keeps KV reads off the request path; every
// write through this repo invalidates it immediately.

const SNAPSHOT_TTL_MS = 3000;
let snapshot = null;

function invalidatePromptSnapshot() {
  snapshot = null;
}

async function getPromptSnapshot() {
  if (snapshot && Date.now() - snapshot.at < SNAPSHOT_TTL_MS) return snapshot;
  const [profiles, bindings] = await Promise.all([
    getPromptProfiles(),
    getPromptBindings(),
  ]);
  snapshot = { at: Date.now(), profiles, bindings };
  return snapshot;
}

// Load profiles + bindings and resolve the inject list for one request.
export async function resolvePromptInjects(ctx = {}) {
  try {
    const { profiles, bindings } = await getPromptSnapshot();
    return selectPromptInjects(profiles, bindings, ctx);
  } catch {
    return []; // fail-open: injection must never break chat
  }
}
