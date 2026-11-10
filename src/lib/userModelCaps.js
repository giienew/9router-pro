// Server-only reader for per-model capability overrides (model editor).
//
// The editor stores sparse overrides in the customModels kv (one row per
// provider+model, `capsOverride` = only the fields the user set; absent key
// = "Auto", use detection). This module loads those rows into a small
// in-memory map and hands a sync `getOverride(provider, model)` to
// capabilities.js via setUserCapsSource() — the same install pattern as the
// synced catalog (open-sse/providers/catalogOverride.js), because
// capabilities.js is bundled into the browser too and cannot import the DB.
//
// Hot path is a Map lookup: the kv is re-read at most once per TTL, plus an
// immediate reload whenever a custom-model write invalidates the cache, so
// no request ever hits the DB. Everything here is fail-open — a missing DB,
// a corrupt row or a load error just means "no override", i.e. detection.

import { makeKv } from "./db/helpers/kvStore.js";
import { ALIAS_TO_ID } from "@/shared/constants/providers.js";
import { sanitizeModelCapsOverride } from "@/shared/constants/models.js";
import { setUserCapsSource } from "open-sse/providers/capabilities.js";

const customKv = makeKv("customModels");

// Staleness is bounded by the TTL even if a write path misses its
// invalidate call (same policy as the /v1/models list cache).
const TTL_MS = 5000;

let cache = { at: 0, byKey: new Map() };
let inflight = null;

// Mirror catalogOverride.baseId: vendor prefix off, lowercase, ":free"-style
// suffix off, so "nvidia/stepfun-ai/step-5-preview" and "step-5-preview"
// resolve to the same model key.
function baseId(model) {
  if (!model) return "";
  const withoutVendor = String(model).includes("/") ? String(model).split("/").pop() : String(model);
  return withoutVendor.toLowerCase().split(":")[0];
}

function indexRow(byKey, row) {
  if (!row || typeof row !== "object") return;
  if ((row.kind || row.type || "llm") !== "llm") return;
  const override = sanitizeModelCapsOverride(row.capsOverride);
  if (!override || Object.keys(override).length === 0) return;
  const alias = String(row.providerAlias || "").toLowerCase();
  const id = (ALIAS_TO_ID[row.providerAlias] || row.providerAlias || "").toLowerCase();
  const modelKey = baseId(row.id);
  if (!alias || !modelKey) return;
  byKey.set(`${alias}:${modelKey}`, override);
  if (id && id !== alias) byKey.set(`${id}:${modelKey}`, override);
}

async function loadOverrides() {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const all = await customKv.getAll();
      const byKey = new Map();
      for (const row of Object.values(all || {})) indexRow(byKey, row);
      cache = { at: Date.now(), byKey };
    } catch {
      // Fail-open: keep the previous map (possibly empty) and retry after TTL.
    } finally {
      inflight = null;
    }
    return cache.byKey;
  })();
  return inflight;
}

// Sync read for the capabilities hot path. A stale cache triggers a
// background reload and still serves the previous map — never a DB hit here.
export function getUserCapsOverride(provider, model) {
  if (Date.now() - cache.at > TTL_MS) void loadOverrides();
  const base = baseId(model);
  if (!base) return null;
  const candidates = [];
  if (provider) candidates.push(String(provider).toLowerCase());
  // The model arg itself may carry "provider/model" (combo seats call with
  // provider null); the first segment is the provider hint. A bare vendor
  // prefix ("stepfun-ai/step-5-preview") is not a provider and simply misses.
  const slash = String(model || "").indexOf("/");
  if (slash > 0) candidates.push(String(model).slice(0, slash).toLowerCase());
  for (const p of candidates) {
    const hit = cache.byKey.get(`${p}:${base}`);
    if (hit) return hit;
  }
  return null;
}

// Called from the custom-model repo mutators after every write, so an edit
// takes effect on the next request instead of after the TTL.
export function invalidateUserModelCaps() {
  cache = { at: 0, byKey: cache.byKey };
  void loadOverrides();
}

// Hand the reader to capabilities.js. Called once at server startup from
// src/instrumentation.js; until then getCapabilitiesForModel resolves by
// detection alone (source null = no override).
export async function installUserCapsSource() {
  await loadOverrides().catch(() => {});
  setUserCapsSource({ getOverride: getUserCapsOverride });
}
