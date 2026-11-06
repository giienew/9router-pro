import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";
import { invalidateModelsListCache } from "../../../sse/services/modelsListCache.js";
import { invalidateUserModelCaps } from "../../userModelCaps.js";

const aliasKv = makeKv("modelAliases");
const customKv = makeKv("customModels");
const mitmKv = makeKv("mitmAlias");

// modelAliases: key=alias, value=modelString
export async function getModelAliases() {
  return await aliasKv.getAll();
}

export async function setModelAlias(alias, model) {
  await aliasKv.set(alias, model);
  invalidateModelsListCache();
}

export async function deleteModelAlias(alias) {
  await aliasKv.remove(alias);
  invalidateModelsListCache();
}

// customModels: key=`${providerAlias}|${id}|${type}`, value=full model object
function customKey(providerAlias, id, type) {
  return `${providerAlias}|${id}|${type}`;
}

export async function getCustomModels() {
  const all = await customKv.getAll();
  return Object.values(all);
}

// Atomic upsert inside transaction to prevent duplicate races.
// Re-adding an existing model updates caps/name/transport without resetting omitted fields.
// `capsOverride` is the model editor's sparse override (only the fields the
// user set; {} = all Auto = clear). It is stored alongside the legacy `caps`
// and never merged with it: the runtime and /api/models read capsOverride
// only, so an old add-flow row ({vision, reasoning} defaults) can never
// turn a detected capability off by accident.
// Both the insert and the update path invalidate the models-list cache AND
// the user-caps cache — the update path previously skipped invalidation, so
// an edit to an existing row stayed invisible until the TTL expired.
export async function addCustomModel({ providerAlias, id, type = "llm", name, caps, capsOverride, transport }) {
  const k = customKey(providerAlias, id, type);
  const db = await getAdapter();
  let added = false;
  db.transaction(() => {
    const row = db.get(`SELECT value FROM kv WHERE scope = 'customModels' AND key = ?`, [k]);
    if (row) {
      const prev = parseJson(row.value) || {};
      const next = { ...prev, ...(name ? { name } : {}), ...(caps ? { caps } : {}), ...(capsOverride !== undefined ? { capsOverride } : {}), ...(transport ? { transport } : {}) };
      db.run(`UPDATE kv SET value = ? WHERE scope = 'customModels' AND key = ?`, [stringifyJson(next), k]);
      return;
    }
    const value = stringifyJson({ providerAlias, id, type, name: name || id, ...(caps ? { caps } : {}), ...(capsOverride !== undefined ? { capsOverride } : {}), ...(transport ? { transport } : {}) });
    db.run(`INSERT INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, value]);
    added = true;
  });
  invalidateModelsListCache();
  invalidateUserModelCaps();
  return added;
}

export async function deleteCustomModel({ providerAlias, id, type = "llm" }) {
  await customKv.remove(customKey(providerAlias, id, type));
  invalidateModelsListCache();
  invalidateUserModelCaps();
}

// mitmAlias: key=toolName, value=mappings object
export async function getMitmAlias(toolName) {
  if (toolName) {
    const v = await mitmKv.get(toolName);
    return v || {};
  }
  return await mitmKv.getAll();
}

export async function setMitmAliasAll(toolName, mappings) {
  await mitmKv.set(toolName, mappings || {});
}
