// Public API barrel — all DB functions
import { getAdapter } from "./driver.js";
import { stringifyJson, parseJson } from "./helpers/jsonCol.js";
import { makeBackupDir, backupDbLite, pruneOldBackups } from "./backup.js";
import { getAppVersion } from "./version.js";

// KV scopes that travel with a Settings backup: the four legacy ones plus
// the Pro-era scopes. The legacy four are always replaced on import (they
// exist in every backup file ever written); the EXTRA scopes are only
// replaced when the payload actually carries the section, so importing an
// older backup never wipes newer data (prompt injections, quotas, brief
// modes) it knows nothing of. tokenSaverStats is statistics rather than
// configuration, but it rides along so a restore keeps the savings history.
const EXTRA_KV_SCOPES = ["promptInjections", "promptPresets", "keyQuotas", "keyLimits", "disabledModels", "briefMode", "tokenSaverStats"];

// Which backup section group each KV scope belongs to (selective backup).
const KV_SCOPE_GROUPS = {
  promptInjections: "prompts",
  promptPresets: "prompts",
  keyQuotas: "apiKeys",
  keyLimits: "apiKeys",
  disabledModels: "settings",
  briefMode: "settings",
  tokenSaverStats: "settings",
};
import { keyAccessFromColumns, keyAccessToColumns, validateKeyAccessInput } from "@/shared/utils/keyAccess.js";
import { KEY_ACCESS_UNRESTRICTED } from "@/shared/constants/keyAccess.js";
import { sanitizeSections, sanitizeProviders, payloadSections, BACKUP_GROUP_IDS } from "../backup/summary.js";

// Settings
export {
  getSettings, updateSettings, isCloudEnabled, getCloudUrl, exportSettings,
} from "./repos/settingsRepo.js";

// Provider connections
export {
  getProviderConnections, getProviderConnectionById,
  getProviderConnectionStats, bulkSetConnectionsActive, getProviderConnectionsPage,
  createProviderConnection, updateProviderConnection,
  deleteProviderConnection, deleteProviderConnectionsByProvider,
  reorderProviderConnections, cleanupProviderConnections,
} from "./repos/connectionsRepo.js";

// Provider nodes
export {
  getProviderNodes, getProviderNodeById,
  createProviderNode, updateProviderNode, deleteProviderNode,
} from "./repos/nodesRepo.js";

// Proxy pools
export {
  getProxyPools, getProxyPoolById,
  createProxyPool, updateProxyPool, deleteProxyPool,
} from "./repos/proxyPoolsRepo.js";

// API keys
export {
  getApiKeys, getApiKeyById, getApiKeyByKey, createApiKey, updateApiKey, deleteApiKey, validateApiKey,
} from "./repos/apiKeysRepo.js";

// Combos
export {
  getCombos, getComboById, getComboByName,
  createCombo, updateCombo, deleteCombo,
} from "./repos/combosRepo.js";

// Aliases (model + custom + mitm)
export {
  getModelAliases, setModelAlias, deleteModelAlias,
  getCustomModels, addCustomModel, deleteCustomModel,
  getMitmAlias, setMitmAliasAll,
} from "./repos/aliasRepo.js";

// Prompt Injection (9Router Pro) — target-coordinate injections + templates
export {
  getInjectModelPrompts, setInjectModelPrompt, deleteInjectModelPrompt,
  getInjectUserPrompts, setInjectUserPrompt, deleteInjectUserPrompt,
  getInjectKeyModelPrompts, setInjectKeyModelPrompt, deleteInjectKeyModelPrompt,
  getInjectGlobal, setInjectGlobal, resolvePromptInjections,
  getPromptTemplates, upsertPromptTemplate, deletePromptTemplate,
} from "./repos/promptInjectRepo.js";

// Key Quotas (9Router Pro)
export {
  getKeyQuota, getAllKeyQuotas, setKeyQuota, deleteKeyQuota,
  getKeyUsageInWindow, checkKeyQuota,
} from "./repos/keyQuotaRepo.js";

// Key Limits (9Router Pro) — per-key RPM/TPM/RPH/RPD/concurrency config
export {
  getKeyLimits, getAllKeyLimits, setKeyLimits, deleteKeyLimits,
  cleanKeyLimits, LIMIT_FIELDS,
} from "./repos/keyLimitRepo.js";

// Brief Mode (Pro) + Token Saver savings stats (Pro)
export {
  getBriefModes, getBriefGlobal, getBriefByKey, getBriefByModel,
  setBriefGlobal, setBriefForKey, setBriefForModel,
  resolveBriefLevel, selectBriefLevel,
} from "./repos/briefModeRepo.js";
export {
  recordRtkSavings, flushTokenSaverStats, getTokenSaverStats,
} from "./repos/tokenSaverStatsRepo.js";

// Pricing
export {
  getPricing, getPricingForModel, updatePricing, resetPricing, resetAllPricing,
} from "./repos/pricingRepo.js";

// Disabled models
export {
  getDisabledModels, getDisabledByProvider, disableModels, enableModels,
} from "./repos/disabledModelsRepo.js";

// Usage
export {
  statsEmitter, trackPendingRequest, getActiveRequests,
  saveRequestUsage, getUsageHistory, getUsageStats, getChartData,
  appendRequestLog, getRecentLogs,
} from "./repos/usageRepo.js";

// Request details
export {
  saveRequestDetail, getRequestDetails, getRequestDetailById, getDistinctProviders,
  isObservabilityEnabled,
} from "./repos/requestDetailsRepo.js";

// Export/import full DB. Export accepts a selective scope: `sections`
// (backup group ids) limits which groups carry data, and `providers`
// limits the connections group to those providers' connections. A
// selective export declares itself in the payload (`sections` /
// `providers`) so a later import restores exactly that scope — nothing
// outside it is touched. No options = the classic full backup.
export async function exportDb(options = {}) {
  const db = await getAdapter();
  const { exportSettings } = await import("./repos/settingsRepo.js");

  const only = sanitizeSections(options.sections);
  const providerFilter = sanitizeProviders(options.providers);
  const wants = (group) => !only || only.includes(group);
  const providerSet = providerFilter ? new Set(providerFilter) : null;

  const out = {
    format: "9router-backup",
    appVersion: getAppVersion(),
    exportedAt: new Date().toISOString(),
    settings: wants("settings") ? await exportSettings() : null,
    providerConnections: wants("connections")
      ? db.all(`SELECT * FROM providerConnections`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, provider: r.provider, authType: r.authType, name: r.name, email: r.email, priority: r.priority, isActive: r.isActive === 1, createdAt: r.createdAt, updatedAt: r.updatedAt })).filter((c) => !providerSet || providerSet.has(c.provider))
      : [],
    providerNodes: wants("connections")
      ? db.all(`SELECT * FROM providerNodes`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, type: r.type, name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt })).filter((n) => !providerSet || providerSet.has(n.id))
      : [],
    proxyPools: wants("proxyPools") ? db.all(`SELECT * FROM proxyPools`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, isActive: r.isActive === 1, testStatus: r.testStatus, createdAt: r.createdAt, updatedAt: r.updatedAt })) : [],
    apiKeys: wants("apiKeys") ? db.all(`SELECT * FROM apiKeys`).map((r) => ({ id: r.id, key: r.key, name: r.name, machineId: r.machineId, isActive: r.isActive === 1, createdAt: r.createdAt, access: keyAccessFromColumns(r.accessRestricted, r.accessAllow) })) : [],
    combos: wants("combos") ? db.all(`SELECT * FROM combos`).map((r) => ({ id: r.id, name: r.name, kind: r.kind, models: parseJson(r.models, []), createdAt: r.createdAt, updatedAt: r.updatedAt })) : [],
    modelAliases: {},
    customModels: [],
    mitmAlias: {},
    pricing: {},
    promptInjections: {},
    promptPresets: {},
    keyQuotas: {},
    keyLimits: {},
    disabledModels: {},
    briefMode: {},
    tokenSaverStats: {},
  };

  if (wants("combos")) {
    for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'modelAliases'`)) out.modelAliases[r.key] = parseJson(r.value);
    for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'customModels'`)) out.customModels.push(parseJson(r.value));
    for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'mitmAlias'`)) out.mitmAlias[r.key] = parseJson(r.value);
  }
  if (wants("settings")) {
    for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'pricing'`)) out.pricing[r.key] = parseJson(r.value);
  }
  for (const scope of EXTRA_KV_SCOPES) {
    if (!wants(KV_SCOPE_GROUPS[scope])) continue;
    for (const r of db.all(`SELECT key, value FROM kv WHERE scope = ?`, [scope])) out[scope][r.key] = parseJson(r.value);
  }

  if (only) {
    out.partial = true;
    out.sections = only;
  }
  if (providerFilter) {
    out.partial = true;
    out.providers = providerFilter;
  }

  return out;
}

export async function importDb(payload, options = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid database payload");
  }
  const db = await getAdapter();

  // Selective restore: `options.sections` applies a subset of the groups
  // the file carries (payloadSections); groups not applied keep their
  // current data. A file that declares `providers` restores connections
  // scoped to those providers — other providers' connections survive.
  // No options + a full file = the classic replace-everything import.
  const selected = sanitizeSections(options.sections);
  const declared = payloadSections(payload);
  const applies = (group) => declared.includes(group) && (!selected || selected.includes(group));
  const fileProviders = sanitizeProviders(payload.providers);

  // Safety snapshot BEFORE the wipe: importing a wrong-but-valid file must
  // never be unrecoverable. Same lightweight backup the schema migrator
  // takes (excludes the request-details log); newest 3 are kept.
  try {
    const dir = makeBackupDir("pre-import");
    backupDbLite(db, dir);
    pruneOldBackups();
  } catch (e) {
    console.warn("[DB] Pre-import backup failed (continuing):", e?.message || e);
  }

  db.transaction(() => {
    // Wipe the tables of the applied groups only (keep _meta). In a full
    // import that is every table, exactly as before.
    if (applies("settings")) db.run(`DELETE FROM settings`);
    if (applies("connections")) {
      if (fileProviders) {
        const marks = fileProviders.map(() => "?").join(",");
        db.run(`DELETE FROM providerConnections WHERE provider IN (${marks})`, fileProviders);
        db.run(`DELETE FROM providerNodes WHERE id IN (${marks})`, fileProviders);
      } else {
        db.run(`DELETE FROM providerConnections`);
        db.run(`DELETE FROM providerNodes`);
      }
    }
    if (applies("proxyPools")) db.run(`DELETE FROM proxyPools`);
    if (applies("apiKeys")) db.run(`DELETE FROM apiKeys`);
    if (applies("combos")) db.run(`DELETE FROM combos`);
    const legacyKvScopes = [
      ...(applies("combos") ? ["modelAliases", "customModels", "mitmAlias"] : []),
      ...(applies("settings") ? ["pricing"] : []),
    ];
    if (legacyKvScopes.length) {
      db.run(`DELETE FROM kv WHERE scope IN (${legacyKvScopes.map(() => "?").join(",")})`, legacyKvScopes);
    }
    // Pro-era scopes: replace only when the payload carries the section —
    // an older backup (without them) leaves current data untouched.
    for (const scope of EXTRA_KV_SCOPES) {
      const section = payload[scope];
      if (section && typeof section === "object" && !Array.isArray(section) && applies(KV_SCOPE_GROUPS[scope])) {
        db.run(`DELETE FROM kv WHERE scope = ?`, [scope]);
        for (const [k, v] of Object.entries(section)) {
          db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES(?, ?, ?)`, [scope, k, stringifyJson(v)]);
        }
      }
    }

    // Settings
    if (applies("settings") && payload.settings) {
      db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [stringifyJson(payload.settings)]);
    }

    for (const c of payload.providerConnections || []) {
      if (!applies("connections")) continue;
      const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
      db.run(
        `INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, provider, authType || "oauth", name || null, email || null, priority || null, isActive === false ? 0 : 1, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const n of payload.providerNodes || []) {
      if (!applies("connections")) continue;
      const { id, type, name, createdAt, updatedAt, ...rest } = n;
      db.run(
        `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [id, type || null, name || null, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const p of payload.proxyPools || []) {
      if (!applies("proxyPools")) continue;
      const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
      db.run(
        `INSERT OR REPLACE INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [id, isActive === false ? 0 : 1, testStatus || "unknown", stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const k of payload.apiKeys || []) {
      if (!applies("apiKeys")) continue;
      // Per-key access: a backup without `access` (older version) restores
      // unrestricted, exactly as before; a malformed `access` is refused.
      let access = KEY_ACCESS_UNRESTRICTED;
      if (k.access !== undefined) {
        const checked = validateKeyAccessInput(k.access);
        if (!checked.ok) throw new Error(`apiKeys ${k.id}: ${checked.error}`);
        access = checked.value;
      }
      const cols = keyAccessToColumns(access);
      db.run(
        `INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, createdAt, accessRestricted, accessAllow) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
        [k.id, k.key, k.name || null, k.machineId || null, k.isActive === false ? 0 : 1, k.createdAt || new Date().toISOString(), cols.accessRestricted, cols.accessAllow]
      );
    }
    for (const c of payload.combos || []) {
      if (!applies("combos")) continue;
      db.run(
        `INSERT OR REPLACE INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [c.id, c.name, c.kind || null, stringifyJson(c.models || []), c.createdAt || new Date().toISOString(), c.updatedAt || new Date().toISOString()]
      );
    }
    for (const [a, m] of Object.entries(payload.modelAliases || {})) {
      if (!applies("combos")) continue;
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [a, stringifyJson(m)]);
    }
    for (const m of payload.customModels || []) {
      if (!applies("combos")) continue;
      const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`;
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, stringifyJson(m)]);
    }
    for (const [tool, mappings] of Object.entries(payload.mitmAlias || {})) {
      if (!applies("combos")) continue;
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)`, [tool, stringifyJson(mappings || {})]);
    }
    for (const [provider, models] of Object.entries(payload.pricing || {})) {
      if (!applies("settings")) continue;
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('pricing', ?, ?)`, [provider, stringifyJson(models || {})]);
    }
  });

  return await exportDb();
}

// Eager init helper (optional)
export async function initDb() {
  await getAdapter();
}
