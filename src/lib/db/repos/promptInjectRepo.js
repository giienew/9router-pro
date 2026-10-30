// Prompt Injection (9Router Pro) — prompts attached to a request by
// TARGET COORDINATE: a scope (global / variant name) optionally narrowed
// to one API key. Four combinations, one mental model — "who gets this
// prompt?": everyone, one key, one variant, or one model for one key.
//   · GLOBAL     — scope "promptInjections" key "global"
//   · KEY        — key "byKey":      { [apiKeyId]: entry }
//   · VARIANT    — key "variants":   { [variantName]: variant }
//   · MODEL+KEY  — key "byKeyModel": { [apiKeyId]: { [modelName]: entry } }
// Every coordinate owns exactly ONE injection (saving replaces it). A
// request stacks its matches least → most specific:
//   global → key → variant → model+key.
//
// A VARIANT is a custom-named model: a name the user picks (e.g.
// "dahlunce") backed by exactly one provider/model. Picking the variant
// serves that model WITH the variant's prompt; picking the raw model
// serves it WITHOUT any prompt — the original model name is never
// disturbed by an injection. A variant name routes directly: dispatch
// checks the variants map, so no combo object is created per variant
// (comboId stays null; entries written before this change keep theirs
// until re-saved or migrated). Model-coordinate injections from the
// earlier concept no longer exist: any still stored are migrated to
// variants on first read (name from the old label, else derived from the
// model), so an existing install keeps its prompts as named variants.
//
// Each injection is one of two modes:
//   · "single" — one system prompt (position prepend/append into system)
//   · "chat"   — a scripted conversation (user/assistant turns) inserted
//                as fake history right after the system message(s), so the
//                model treats it as something that already happened
//   entry = { mode, content, turns: [{ role, content }], position,
//             enabled, updatedAt, templateName?, name? }
//
// TEMPLATES (scope "promptPresets", key "list") are a pure prompt
// library: name + entry, no targets, never fired on their own. Using a
// template COPIES its content into an injection (snapshot semantics, so
// editing a template never silently changes live behavior) and stamps
// the injection with templateName as provenance. (The KV scope keeps its
// historical name so existing installs keep their data; entries written
// by the earlier preset-with-targets build lose their targets on read —
// the prompt itself is preserved.)
//
// Model lookup: exactly one key — the resolved "provider/model" of the
// model that serves the request. Variant lookup: exactly one key — the
// bare custom name the user requested, when it has no "/". A variant pick
// suppresses the model and model+key matches: the variant is a different
// model identity, and the raw model's prompt must never leak into it.
// Picking the raw model matches nothing but global/key — the original
// model name is never disturbed. Data written by the earlier "Soul
// Prompts" build (scope "soulPrompts", content-only entries) is migrated
// on first read and treated as "single".

import { makeKv } from "../helpers/kvStore.js";
import { getCombos, getComboByName, getComboById, deleteCombo } from "./combosRepo.js";
import { getModelAliases } from "./aliasRepo.js";
import { invalidateModelsListCache } from "../../../sse/services/modelsListCache.js";
import { getProviderNodes, resolveRoutableBacking } from "./nodesRepo.js";
import { normalizePromptMap, normalizeKeyModelMap, buildProviderResolver } from "../normalizeInjections.js";

const kv = makeKv("promptInjections");
const legacyKv = makeKv("soulPrompts");
const templatesKv = makeKv("promptPresets");
const GLOBAL_KEY = "global";
const BYKEY_KEY = "byKey";
const MODELS_KEY = "prompts";
const BYKEYMODEL_KEY = "byKeyModel";
const VARIANTS_KEY = "variants";
const TEMPLATES_KEY = "list";
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
    // Provenance only: set when the entry was copied from a template.
    templateName:
      typeof raw.templateName === "string" && raw.templateName.trim()
        ? raw.templateName.trim().slice(0, 80)
        : null,
    // Custom name for this entry: shown as the card title and in the
    // picker's Custom Injections section. Never a match key — matching
    // still uses the provider/model coordinate only. Older entries stored
    // it as `label`; that spelling still reads back as the name.
    name:
      typeof raw.name === "string" && raw.name.trim()
        ? raw.name.trim().slice(0, 80)
        : typeof raw.label === "string" && raw.label.trim()
          ? raw.label.trim().slice(0, 80)
          : null,
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
    templateName: input.templateName,
    name: input.name || input.label,
    updatedAt: new Date().toISOString(),
  });
}

// ------------------------------------------------------------ migration
// One-time copy from the legacy "soulPrompts" scope. Runs lazily on first
// read; a no-op once the new scope holds anything.
let migrated = false;
async function ensureMigrated() {
  if (migrated) return;
  try {
    const [g, k, m] = await Promise.all([
      kv.get(GLOBAL_KEY, null), kv.get(BYKEY_KEY, null), kv.get(MODELS_KEY, null),
    ]);
    if (g || k || m) { migrated = true; return; }
    const [lg, lk, lm] = await Promise.all([
      legacyKv.get(GLOBAL_KEY, null), legacyKv.get(BYKEY_KEY, null), legacyKv.get(MODELS_KEY, null),
    ]);
    if (lg) await kv.set(GLOBAL_KEY, lg);
    if (lk) await kv.set(BYKEY_KEY, lk);
    if (lm) await kv.set(MODELS_KEY, lm);
    // Flag only after success: a failed first migration used to be
    // marked done and never retried until restart, leaving legacy data
    // silently unmigrated. On failure the flag stays false so a later
    // read retries (reads stay fail-open either way).
    migrated = true;
  } catch { /* fail-open: migration must never break reads */ }
}

// ------------------------------------------------------------ concept migration
// One-time expansion of legacy injection keys — combo names from the old
// concept and bare model ids from the bare-id concept — to resolved
// "provider/model" keys, so an existing install keeps its prompts after
// upgrading without re-importing a backup. Runs lazily on first read of
// either model map; a no-op once every key is already a provider/model.
// Fail-open: any error leaves the maps untouched (legacy keys then
// simply never match, which is the new concept's rule anyway).
let conceptMigrated = false;
async function ensureConceptMigrated() {
  if (conceptMigrated) return;
  try {
    const [promptsRaw, keyModelRaw] = await Promise.all([
      kv.get(MODELS_KEY, null),
      kv.get(BYKEYMODEL_KEY, null),
    ]);
    const hasKeys = (m) => m && typeof m === "object" && Object.keys(m).length > 0;
    if (!hasKeys(promptsRaw) && !(keyModelRaw && typeof keyModelRaw === "object" && Object.values(keyModelRaw).some(hasKeys))) { conceptMigrated = true; return; }
    const [combos, nodes] = await Promise.all([getCombos(), getProviderNodes()]);
    // Registry alias map is heavy (144 provider modules); load it lazily
    // and only here, never at module import time.
    const { resolveProviderAlias } = await import("open-sse/services/model.js");
    const resolveProvider = buildProviderResolver(nodes, resolveProviderAlias);
    let changed = false;
    if (hasKeys(promptsRaw)) {
      const normalized = await normalizePromptMap(promptsRaw, combos, resolveProvider);
      if (JSON.stringify(normalized) !== JSON.stringify(promptsRaw)) {
        await kv.set(MODELS_KEY, normalized);
        changed = true;
      }
    }
    if (keyModelRaw && typeof keyModelRaw === "object") {
      const normalized = await normalizeKeyModelMap(keyModelRaw, combos, resolveProvider);
      if (JSON.stringify(normalized) !== JSON.stringify(keyModelRaw)) {
        await kv.set(BYKEYMODEL_KEY, normalized);
        changed = true;
      }
    }
    if (changed) invalidateInjectSnapshot();
    // Same rule as ensureMigrated: only a successful run counts, so a
    // failed run is retried on a later read instead of silently skipped.
    conceptMigrated = true;
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
  await ensureConceptMigrated();
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

// --------------------------------------------------------------- variants
// A variant is a custom-named model: { model (backing provider/model),
// comboId (its single-member combo, same name), ...entry }. The name is
// the map key, never a field: it must be non-empty, at most 80 chars,
// and must not contain "/" (a "/" would make it a provider/model value).
// The backing model must be a provider/model ("provider/model").

// Over-long names are rejected, not truncated: truncation silently merged
// two distinct names into one map key (the later save overwrote the first).
export function cleanVariantName(raw) {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name || name.length > 80 || name.includes("/")) return null;
  return name;
}

function cleanVariantEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const backing = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!backing.includes("/")) return null;
  const entry = cleanEntry(raw);
  if (!entry) return null;
  const out = {
    ...entry,
    model: backing,
    comboId: typeof raw.comboId === "string" && raw.comboId ? raw.comboId : null,
  };
  // R7 locked sampling params: numbers only, validated ranges; prompt
  // text is never touched by this path. Absent = client default.
  const sampling = cleanSamplingParams(raw.sampling);
  if (sampling) out.sampling = sampling;
  return out;
}

// R7: validate locked sampling params. temperature 0–2, top_p (0,1],
// max_tokens positive int. Anything else is dropped, never clamped
// silently into a different behaviour the user did not ask for.
export function cleanSamplingParams(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  const t = Number(raw.temperature);
  if (Number.isFinite(t) && t >= 0 && t <= 2) out.temperature = t;
  const p = Number(raw.top_p);
  if (Number.isFinite(p) && p > 0 && p <= 1) out.top_p = p;
  const m = Number(raw.max_tokens);
  if (Number.isFinite(m) && Number.isInteger(m) && m >= 1 && m <= 1000000) out.max_tokens = m;
  return Object.keys(out).length ? out : null;
}

// R7: pure dispatch override — variant sampling wins over client defaults,
// for that variant only. Returns a new body; the input is untouched.
export function applyVariantSampling(body, sampling) {
  if (!body || typeof body !== "object" || !sampling) return body;
  const out = { ...body };
  if (sampling.temperature !== undefined) out.temperature = sampling.temperature;
  if (sampling.top_p !== undefined) out.top_p = sampling.top_p;
  if (sampling.max_tokens !== undefined) out.max_tokens = sampling.max_tokens;
  return out;
}

// R7: sampling for a direct variant pick (bare name, no "/"), else null.
export async function resolveVariantSampling(requestedModel) {
  if (typeof requestedModel !== "string" || !requestedModel || requestedModel.includes("/")) return null;
  try {
    const variants = await getInjectVariants();
    const entry = variants[requestedModel];
    return entry?.sampling ? cleanSamplingParams(entry.sampling) : null;
  } catch { return null; }
}

function cleanVariantMap(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [name, entry] of Object.entries(raw)) {
    if (!cleanVariantName(name)) continue;
    const clean = cleanVariantEntry(entry);
    if (clean) out[name] = clean;
  }
  return out;
}

export async function getInjectVariants() {
  await ensureMigrated();
  return cleanVariantMap(await kv.get(VARIANTS_KEY, null));
}
export async function setInjectVariant(name, input = {}) {
  const cleanName = cleanVariantName(name);
  if (!cleanName) return null;
  const map = await getInjectVariants();
  const entry = cleanVariantEntry({ ...input, updatedAt: new Date().toISOString() });
  if (!entry) {
    if (!(cleanName in map)) return null;
    await deleteInjectVariant(cleanName);
    return null;
  }
  // AUTO: an alias-prefix backing (e.g. tokenharbor/...) would 404 at
  // runtime because chat never maps prefixes to node ids — convert it to
  // the routable node-id form here, once, at save time.
  const nodes = await getProviderNodes().catch(() => []);
  const routedModel = resolveRoutableBacking(entry.model, nodes);
  if (routedModel === null) return null;
  const routedEntry = routedModel === entry.model ? entry : { ...entry, model: routedModel };
  // No backing combo: a variant name routes directly (dispatch checks the
  // variants map), so saving a variant creates no combo object — the
  // Kombinasi page shows only combos the user actually made.
  // A new variant name must not shadow a real combo (dispatch checks
  // combos first, so a colliding variant would be unreachable);
  // re-saving an existing variant is always fine.
  if (!(cleanName in map) && (await getComboByName(cleanName).catch(() => null))) return null;
  // A new variant name must not shadow a model alias either: dispatch
  // checks variants before aliases, so a colliding variant would silently
  // hijack the alias route. Re-saving an existing variant is always fine.
  if (!(cleanName in map)) {
    const aliases = await getModelAliases().catch(() => ({}));
    if (aliases && typeof aliases === "object" && cleanName in aliases) return null;
  }
  map[cleanName] = { ...routedEntry, comboId: null };
  await kv.set(VARIANTS_KEY, map);
  invalidateInjectSnapshot();
  invalidateModelsListCache();
  return map[cleanName];
}

export async function deleteInjectVariant(name) {
  const cleanName = cleanVariantName(name);
  if (!cleanName) return false;
  const map = await getInjectVariants();
  const variant = map[cleanName];
  if (!variant) return false;
  if (variant.comboId) {
    const combo = await getComboById(variant.comboId).catch(() => null);
    if (combo && combo.name === cleanName) {
      await deleteCombo(combo.id).catch(() => {});
    }
  }
  delete map[cleanName];
  await kv.set(VARIANTS_KEY, map);
  invalidateInjectSnapshot();
  invalidateModelsListCache();
  return true;
}

// ------------------------------------------------------- variant migration
// One-time conversion of stored model-coordinate injections (the earlier
// concept) into variants, so an existing install keeps its prompts as
// named models and its raw models go back to undisturbed. Name: the old
// label when one was set, else provider + slugged bare model. Collisions
// with existing variant or combo names get a -2/-3 suffix. Entries that
// cannot convert (no prompt, no backing) stay in the model map, never
// silently dropped. Fail-open and idempotent: a drained map is a no-op,
// a partial run retries the leftovers on the next read.
function slugVariantName(model) {
  const slash = model.indexOf("/");
  const provider = slash > 0 ? model.slice(0, slash) : "custom";
  const providerPart = provider.startsWith("openai-compatible-chat-") ? "custom" : provider;
  const last = model.slice(model.lastIndexOf("/") + 1);
  const slugged = last.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "model";
  return `${providerPart}-${slugged}`.slice(0, 80);
}

// Fingerprint of the model map the last variant migration left behind.
// Entries that cannot convert (no prompt, no backing) stay as leftovers,
// so without this the migration would rewrite both maps and invalidate
// both caches on every snapshot miss, forever, with nothing changing.
// When the map matches the fingerprint, the only remainder is those same
// leftovers — skip the run. Any user edit changes the map and re-arms it.
let variantMigrationFingerprint = null;

export async function migrateModelPromptsToVariants() {
  try {
    await ensureConceptMigrated();
    const raw = await kv.get(MODELS_KEY, null);
    if (!raw || typeof raw !== "object" || !Object.keys(raw).length) return 0;
    if (variantMigrationFingerprint !== null && JSON.stringify(raw) === variantMigrationFingerprint) return 0;
    const variants = await getInjectVariants();
    const combos = await getCombos().catch(() => []);
    const taken = new Set([...Object.keys(variants), ...combos.map((c) => c.name)]);
    const leftovers = {};
    let migratedCount = 0;
    // Only fingerprint when every leftover is permanently unconvertible
    // (no prompt, or no provider/model shape). A leftover from a
    // transient throw must retry on the next run, not be frozen in.
    let transientLeftover = false;
    for (const [model, entryRaw] of Object.entries(raw)) {
      try {
        const entry = cleanEntry(entryRaw);
        if (!entry || !model.includes("/")) { leftovers[model] = entryRaw; continue; }
        let base = entry.name || slugVariantName(model);
        // Cap the first candidate too, and build the "-N" suffix inside the
        // 80-char budget: slicing a full-length base cut the suffix away,
        // leaving the candidate unchanged and the loop below spinning
        // forever on an 80-char colliding name.
        let candidate = base.slice(0, 80);
        let n = 2;
        while (taken.has(candidate)) {
          const suffix = `-${n++}`;
          candidate = base.slice(0, 80 - suffix.length) + suffix;
        }
        variants[candidate] = { ...entry, model, comboId: null };
        taken.add(candidate);
        migratedCount++;
      } catch {
        leftovers[model] = entryRaw;
        transientLeftover = true;
      }
    }
    if (!transientLeftover) variantMigrationFingerprint = JSON.stringify(leftovers);
    await kv.set(VARIANTS_KEY, variants);
    invalidateModelsListCache();
    if (Object.keys(leftovers).length) await kv.set(MODELS_KEY, leftovers);
    else await kv.remove(MODELS_KEY);
    invalidateInjectSnapshot();
    return migratedCount;
  } catch {
    return 0;
  }
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

// ------------------------------------------------------- per model + key

function cleanKeyModelMap(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [keyId, models] of Object.entries(raw)) {
    const cleaned = cleanMap(models);
    if (keyId && Object.keys(cleaned).length) out[keyId] = cleaned;
  }
  return out;
}

export async function getInjectKeyModelPrompts() {
  await ensureMigrated();
  await ensureConceptMigrated();
  return cleanKeyModelMap(await kv.get(BYKEYMODEL_KEY, null));
}

export async function setInjectKeyModelPrompt(keyId, model, input = {}) {
  const id = typeof keyId === "string" ? keyId.trim() : "";
  const name = typeof model === "string" ? model.trim() : "";
  if (!id || !name) return null;
  const all = await getInjectKeyModelPrompts();
  const entry = stamp(input);
  if (!entry) {
    if (all[id]) {
      delete all[id][name];
      if (!Object.keys(all[id]).length) delete all[id];
    }
  } else {
    if (!all[id]) all[id] = {};
    all[id][name] = entry;
  }
  await kv.set(BYKEYMODEL_KEY, all);
  invalidateInjectSnapshot();
  return entry;
}

export async function deleteInjectKeyModelPrompt(keyId, model) {
  const all = await getInjectKeyModelPrompts();
  if (!all[keyId] || !(model in all[keyId])) return false;
  delete all[keyId][model];
  if (!Object.keys(all[keyId]).length) delete all[keyId];
  await kv.set(BYKEYMODEL_KEY, all);
  invalidateInjectSnapshot();
  return true;
}

// ------------------------------------------------------------- templates
// A template is a named, reusable prompt — library only. It has no
// targets and no runtime role: applying one copies its content into an
// injection (see the header note on snapshot semantics).
//   scope "promptPresets": key "list" → [template]
//   template = { id, name, mode, content, turns, position, enabled,
//                updatedAt }

export function cleanTemplate(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 80) : "";
  if (!id || !name) return null;
  const entry = cleanEntry(raw);
  if (!entry) return null;
  return { id, name, ...entry };
}

function cleanTemplateList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const t of raw) {
    const clean = cleanTemplate(t);
    if (clean) out.push(clean);
  }
  return out;
}

export async function getPromptTemplates() {
  return cleanTemplateList(await templatesKv.get(TEMPLATES_KEY, null));
}

export async function upsertPromptTemplate(input = {}) {
  const list = await getPromptTemplates();
  const id =
    typeof input.id === "string" && input.id.trim()
      ? input.id.trim()
      : `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const template = cleanTemplate({ ...input, id, updatedAt: new Date().toISOString() });
  if (!template) return null;
  const idx = list.findIndex((t) => t.id === id);
  if (idx >= 0) list[idx] = template;
  else list.push(template);
  await templatesKv.set(TEMPLATES_KEY, list);
  return template;
}

export async function deletePromptTemplate(id) {
  const list = await getPromptTemplates();
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) return false;
  await templatesKv.set(TEMPLATES_KEY, next);
  return true;
}

// --------------------------------------------------------------- resolver

// Pure selection — exported for tests. Stacked least → most specific:
// global → key → variant → model+key. Per model scope, exactly one key
// matches: the resolved "provider/model" — unless the user picked a
// variant by its bare name, in which case the variant matches instead
// and the model scopes stay silent (a variant pick is a different model
// identity). Combo names never match.
export function selectPromptInjections({ global, byKey, byModel, byKeyModel, byVariant } = {}, ctx = {}) {
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

  // A bare requested name (no "/") is a variant pick: its prompt fires
  // and the raw model's scopes stay silent for this request.
  let variantHit = null;
  if (typeof ctx.requestedModel === "string" && ctx.requestedModel && !ctx.requestedModel.includes("/")) {
    const entry = cleanVariantMap(byVariant)[ctx.requestedModel];
    if (entry && entry.enabled) variantHit = { name: ctx.requestedModel, entry };
  }
  if (variantHit) push(variantHit.name, variantHit.entry);

  if (!variantHit) {
    const names = [ctx.resolvedModel]
      .filter((x) => typeof x === "string" && x);
    const firstHit = (map) => {
      for (const name of names) {
        const entry = map[name];
        if (entry && entry.enabled) return { name, entry };
      }
      return null;
    };

    const modelHit = firstHit(cleanMap(byModel));
    if (modelHit) push(modelHit.name, modelHit.entry);

    if (ctx.apiKeyId) {
      const scoped = cleanKeyModelMap(byKeyModel)[ctx.apiKeyId];
      if (scoped) {
        const hit = firstHit(scoped);
        if (hit) push(hit.name, hit.entry);
      }
    }
  }
  return out;
}

// --------------------------------------------------------------- snapshot
// Hot-path cache: 3s TTL, every write above invalidates immediately.

const SNAPSHOT_TTL_MS = 3000;
let snapshot = null;
let snapshotInflight = null;

function invalidateInjectSnapshot() {
  snapshot = null;
}

async function getInjectSnapshot() {
  if (snapshot && Date.now() - snapshot.at < SNAPSHOT_TTL_MS) return snapshot;
  // Coalesce concurrent builds: without this, N simultaneous cache misses
  // each ran the variant migration and rebuilt the snapshot (same 3s-TTL
  // stampede the settings cache already fixed). A write during a build
  // can still land a pre-write snapshot for up to the TTL — the same
  // window the uncoalesced code already had.
  if (!snapshotInflight) {
    snapshotInflight = (async () => {
      await migrateModelPromptsToVariants().catch(() => {});
      const [global, byKey, byModel, byKeyModel, byVariant] = await Promise.all([
        getInjectGlobal(),
        getInjectUserPrompts(),
        getInjectModelPrompts(),
        getInjectKeyModelPrompts(),
        getInjectVariants(),
      ]);
      snapshot = { at: Date.now(), global, byKey, byModel, byKeyModel, byVariant };
      return snapshot;
    })().finally(() => { snapshotInflight = null; });
  }
  return snapshotInflight;
}

// Resolve the injections for one request
// (global → key → variant → model+key). Fail-open.
export async function resolvePromptInjections(ctx = {}) {
  try {
    const snap = await getInjectSnapshot();
    return selectPromptInjections(snap, ctx);
  } catch {
    return [];
  }
}
