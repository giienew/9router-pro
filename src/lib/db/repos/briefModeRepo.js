// Brief Mode (9Router Pro) — per-scope output-terseness levels riding on
// the Caveman injector. One level per target, resolved model → key →
// global (first hit wins, NOT stacked like prompt injections):
//   scope "briefMode": key "global" → level string
//                      key "byKey"  → { apiKeyId: level }
//                      key "byModel" → { modelName: level }
// A resolved level overrides the global Caveman settings for that
// request; no entry → the global settings apply exactly as before.
import { makeKv } from "../helpers/kvStore.js";
import { CAVEMAN_LEVELS } from "../../../../open-sse/rtk/cavemanPrompts.js";

const kv = makeKv("briefMode");
const VALID_LEVELS = new Set(Object.values(CAVEMAN_LEVELS));

export function isValidBriefLevel(level) {
  return typeof level === "string" && VALID_LEVELS.has(level);
}

export async function getBriefGlobal() {
  const v = await kv.get("global");
  return isValidBriefLevel(v) ? v : null;
}

export async function getBriefByKey() {
  const v = await kv.get("byKey");
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

export async function getBriefByModel() {
  const v = await kv.get("byModel");
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

export async function getBriefModes() {
  const [global, byKey, byModel] = await Promise.all([
    getBriefGlobal(), getBriefByKey(), getBriefByModel(),
  ]);
  return { global, byKey, byModel };
}

export async function setBriefGlobal(level) {
  invalidateBriefSnapshot();
  if (level == null) { await kv.remove("global"); return null; }
  if (!isValidBriefLevel(level)) throw new Error(`Invalid brief level: ${level}`);
  await kv.set("global", level);
  return level;
}

export async function setBriefForKey(keyId, level) {
  if (!keyId) throw new Error("keyId required");
  const map = await getBriefByKey();
  if (level == null) delete map[keyId];
  else {
    if (!isValidBriefLevel(level)) throw new Error(`Invalid brief level: ${level}`);
    map[keyId] = level;
  }
  invalidateBriefSnapshot();
  await kv.set("byKey", map);
  return map;
}

export async function setBriefForModel(model, level) {
  if (!model) throw new Error("model required");
  const map = await getBriefByModel();
  if (level == null) delete map[model];
  else {
    if (!isValidBriefLevel(level)) throw new Error(`Invalid brief level: ${level}`);
    map[model] = level;
  }
  invalidateBriefSnapshot();
  await kv.set("byModel", map);
  return map;
}

// Pure selector — unit-tested. Model match order mirrors prompt
// injections: requested name → resolved provider/model → bare name.
export function selectBriefLevel(data, { apiKeyId, requestedModel, resolvedModel, bareModel } = {}) {
  if (!data) return null;
  const byModel = data.byModel || {};
  for (const name of [requestedModel, resolvedModel, bareModel]) {
    if (name && isValidBriefLevel(byModel[name])) return byModel[name];
  }
  if (apiKeyId && isValidBriefLevel((data.byKey || {})[apiKeyId])) return data.byKey[apiKeyId];
  return isValidBriefLevel(data.global) ? data.global : null;
}

// ------------------------------------------------------------ snapshot
// Hot-path cache: 3s TTL, writes invalidate immediately (same pattern
// as promptInjectRepo).
const SNAPSHOT_TTL_MS = 3000;
let snapshot = null;

function invalidateBriefSnapshot() {
  snapshot = null;
}

async function getBriefSnapshot() {
  if (snapshot && Date.now() - snapshot.at < SNAPSHOT_TTL_MS) return snapshot.data;
  const data = await getBriefModes();
  snapshot = { at: Date.now(), data };
  return data;
}

// Fail-open: a storage hiccup must never break a chat.
export async function resolveBriefLevel(ctx = {}) {
  try {
    return selectBriefLevel(await getBriefSnapshot(), ctx);
  } catch {
    return null;
  }
}
