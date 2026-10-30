import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20127";
const DEFAULT_HEADROOM_URL = process.env.HEADROOM_URL || "http://localhost:8787";

const DEFAULT_SETTINGS = {
  cloudEnabled: false,
  tunnelEnabled: false,
  tunnelUrl: "",
  tunnelProvider: "cloudflare",
  tailscaleEnabled: false,
  tailscaleUrl: "",
  stickyRoundRobinLimit: 3,
  // Global key-routing strategy (profile page). Distinct from
  // comboStrategy below, which routes *within* a combo's members.
  fallbackStrategy: "balanced",
  providerStrategies: {},
  quotaVisibility: {},
  // Global combo strategy default is "auto", not "fallback": "auto" keeps
  // the pair rule (an injected multi-model pair rotates its starting
  // model per request, everything else falls back sequentially), while an
  // explicit "fallback" means fallback everywhere. The old default
  // materialized "fallback" for users who never chose anything, which
  // made an explicit "fallback" indistinguishable from the default — so
  // setting the global strategy to fallback did NOT pin pairs.
  comboStrategy: "auto",
  comboStickyRoundRobinLimit: 1,
  comboStrategies: {},
  // Per-combo member pins (P3-28): { [comboName]: { [member]: { id, label } | id } }
  comboMemberPins: {},
  capacityAdapter: {
    vision: { enabled: true, roundRobin: false, models: [] },
    pdf: { enabled: false, roundRobin: false, models: [] },
    audioInput: { enabled: true, roundRobin: false, models: [] },
    videoInput: { enabled: false, roundRobin: false, models: [] },
  },
  requireLogin: true,
  requireApiKey: true,
  tunnelDashboardAccess: true,
  authMode: "password",
  ssoType: "oidc",
  oidcIssuerUrl: "",
  oidcClientId: "",
  oidcClientSecret: "",
  oidcScopes: "openid profile email",
  oidcLoginLabel: "Sign in with OIDC",
  samlEntryPoint: "",
  samlIssuer: "urn:9router:sp",
  samlCert: "",
  samlLoginLabel: "Sign in with SAML SSO",
  samlAttributeEmail: "email",
  samlAttributeName: "name",
  autoBackupEnabled: true,
  autoBackupKeep: 7,
  lastBackupAt: null,
  enableObservability: false,
  observabilityMaxRecords: 1000,
  observabilityBatchSize: 20,
  observabilityFlushIntervalMs: 5000,
  observabilityMaxJsonSize: 5,
  outboundProxyEnabled: false,
  outboundProxyUrl: "",
  outboundNoProxy: "",
  mitmRouterBaseUrl: DEFAULT_MITM_ROUTER_BASE,
  dnsToolEnabled: {},
  rtkEnabled: true,
  headroomEnabled: false,
  headroomUrl: DEFAULT_HEADROOM_URL,
  headroomCompressUserMessages: false,
  headroomTimeoutMs: 3000,
  cavemanEnabled: false,
  cavemanLevel: "full",
  ponytailEnabled: false,
  ponytailLevel: "full",
  pxpipeEnabled: false,
  pxpipeAutoInstall: true,
  pxpipeMinChars: 25000,
  pxpipeTimeoutMs: 15000,
  // Per-provider user header overrides applied at dispatch: { [providerId]: { headers: {..} } }
  providerOverrides: {},
  // Response cache (chat completions, non-streaming only): exact replays of
  // an identical request body. Off by default — a replay is only correct
  // when the caller wants determinism over freshness.
  responseCache: { enabled: false, ttlSeconds: 3600, maxEntries: 1000 },
  // Scheduled DB maintenance: prune old history + expired cache rows.
  dbMaintenance: { enabled: true, retentionDays: 90, lastRunAt: null, lastResult: null },
};

async function readRaw() {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  return row ? parseJson(row.data, {}) : {};
}

// Merge raw settings with defaults; backward-compat for missing keys
export function mergeWithDefaults(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  for (const [key, defVal] of Object.entries(DEFAULT_SETTINGS)) {
    if (merged[key] === undefined) {
      if (
        key === "outboundProxyEnabled" &&
        typeof merged.outboundProxyUrl === "string" &&
        merged.outboundProxyUrl.trim()
      ) {
        merged[key] = true;
      } else {
        merged[key] = defVal;
      }
    }
  }
  if (merged.capacityAdapter && typeof merged.capacityAdapter === "object") {
    for (const capKey of Object.keys(merged.capacityAdapter)) {
      const entry = merged.capacityAdapter[capKey];
      if (Array.isArray(entry?.models)) {
        entry.models = entry.models.map((m) =>
          m === "oc/mimo-v2.5-free" ? "oc/mimo-v2.6-flash-free" : m
        );
      }
    }
  }
  return merged;
}

// Short settings cache (same 3s tolerance as the inject snapshot): one chat
// request re-reads settings at admission, quota, and per account attempt.
// The cached RAW row is deep-cloned before merging, so callers mutating
// their settings object (several routes do) can never corrupt the cache,
// and every caller still gets its own fresh object. Concurrent in-flight
// reads share one DB round-trip. Writes via updateSettings invalidate.
const SETTINGS_CACHE_TTL_MS = 3000;
let settingsCacheRaw = null;
let settingsCacheAt = 0;
let settingsCacheInflight = null;

function clearSettingsCache() {
  settingsCacheRaw = null;
  settingsCacheAt = 0;
}

export async function getSettings() {
  const now = Date.now();
  if (settingsCacheRaw && now - settingsCacheAt < SETTINGS_CACHE_TTL_MS) {
    return mergeWithDefaults(structuredClone(settingsCacheRaw));
  }
  if (settingsCacheInflight) {
    const raw = await settingsCacheInflight;
    return mergeWithDefaults(structuredClone(raw));
  }
  const pending = readRaw();
  settingsCacheInflight = pending;
  try {
    const raw = await pending;
    settingsCacheRaw = raw;
    settingsCacheAt = Date.now();
    return mergeWithDefaults(structuredClone(raw));
  } finally {
    if (settingsCacheInflight === pending) settingsCacheInflight = null;
  }
}

// Atomic read-merge-write inside transaction (prevents losing concurrent updates)
export async function updateSettings(updates) {
  const db = await getAdapter();
  let next;
  db.transaction(function () {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const current = row ? parseJson(row.data, {}) : {};
    next = { ...current, ...updates };
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(next)],
    );
  });
  clearSettingsCache();
  return mergeWithDefaults(next);
}

export async function isCloudEnabled() {
  const settings = await getSettings();
  return settings.cloudEnabled === true;
}

export async function getCloudUrl() {
  const settings = await getSettings();
  return (
    settings.cloudUrl ||
    process.env.CLOUD_URL ||
    process.env.NEXT_PUBLIC_CLOUD_URL ||
    ""
  );
}

export async function exportSettings() {
  return await readRaw();
}
