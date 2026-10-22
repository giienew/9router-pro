// 9Router Pro — pure helpers for backup payloads: shape check, content
// summary (counts), and snapshot retention. No I/O, no imports — the
// Settings UI numbers, the import preview and the snapshot index all
// derive from these, and they are unit-tested directly.

export const DEFAULT_KEEP = 7;

// Selectable backup sections. A backup file declares which groups it
// carries (payload.sections; older full backups declare nothing and are
// treated as carrying all of them), and an import/restore can apply any
// subset of what the file carries — the rest of the database is left
// untouched. Auto-backup snapshots are always full.
export const BACKUP_GROUPS = [
  { id: "connections", label: "Providers & connections" },
  { id: "apiKeys", label: "API keys" },
  { id: "combos", label: "Combos" },
  { id: "proxyPools", label: "Proxy pools" },
  { id: "prompts", label: "Prompt Injection" },
  { id: "settings", label: "Settings" },
];
export const BACKUP_GROUP_IDS = BACKUP_GROUPS.map((g) => g.id);

// The groups a payload carries: its declared list when present and
// usable, otherwise all of them (legacy full backups).
export function payloadSections(payload) {
  if (Array.isArray(payload?.sections)) {
    const valid = payload.sections.filter((s) => BACKUP_GROUP_IDS.includes(s));
    if (valid.length) return [...new Set(valid)];
  }
  return [...BACKUP_GROUP_IDS];
}

// Sanitize a user-supplied section selection: valid unique group ids, or
// null when nothing usable was given (null means "all").
export function sanitizeSections(input) {
  if (!Array.isArray(input)) return null;
  const valid = [...new Set(input.filter((s) => BACKUP_GROUP_IDS.includes(s)))];
  return valid.length ? valid : null;
}

// Sanitize a provider filter (provider ids whose connections a backup
// carries). A file that declares providers restores connections scoped
// to exactly those providers — every other provider's connections are
// left untouched. null means "no filter" (all providers).
export function sanitizeProviders(input) {
  if (!Array.isArray(input)) return null;
  const valid = [
    ...new Set(
      input
        .filter((s) => typeof s === "string")
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s.length <= 200)
    ),
  ].slice(0, 200);
  return valid.length ? valid : null;
}

export function isBackupPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  if (payload.format === "9router-backup") return true;
  // Older exports predate the format marker; the connections array is the
  // one section every backup has always carried.
  return Array.isArray(payload.providerConnections);
}

function entryHasContent(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (typeof entry.content === "string" && entry.content.trim()) return true;
  if (Array.isArray(entry.turns) && entry.turns.length > 0) return true;
  return false;
}

function countInjections(scope) {
  if (!scope || typeof scope !== "object") return 0;
  let n = 0;
  if (entryHasContent(scope.global)) n += 1;
  const prompts = scope.prompts;
  if (prompts && typeof prompts === "object") {
    for (const e of Object.values(prompts)) if (entryHasContent(e)) n += 1;
  }
  const byKey = scope.byKey;
  if (byKey && typeof byKey === "object") {
    for (const e of Object.values(byKey)) if (entryHasContent(e)) n += 1;
  }
  const byKeyModel = scope.byKeyModel;
  if (byKeyModel && typeof byKeyModel === "object") {
    for (const perKey of Object.values(byKeyModel)) {
      if (perKey && typeof perKey === "object") {
        for (const e of Object.values(perKey)) if (entryHasContent(e)) n += 1;
      }
    }
  }
  return n;
}

function countTemplates(scope) {
  if (!scope || typeof scope !== "object") return 0;
  const list = scope.list;
  return Array.isArray(list) ? list.length : 0;
}

const arrLen = (v) => (Array.isArray(v) ? v.length : 0);

export function summarizeBackup(payload) {
  const valid = isBackupPayload(payload);
  const p = valid ? payload : {};
  const sections = valid ? payloadSections(p) : [];
  const providers = valid ? sanitizeProviders(p.providers) : null;
  return {
    valid,
    format: typeof p.format === "string" ? p.format : null,
    appVersion: typeof p.appVersion === "string" ? p.appVersion : null,
    exportedAt: typeof p.exportedAt === "string" ? p.exportedAt : null,
    sections,
    providers,
    partial: valid && (sections.length < BACKUP_GROUP_IDS.length || providers !== null),
    counts: {
      connections: arrLen(p.providerConnections),
      providerNodes: arrLen(p.providerNodes),
      apiKeys: arrLen(p.apiKeys),
      combos: arrLen(p.combos),
      proxyPools: arrLen(p.proxyPools),
      customModels: arrLen(p.customModels),
      injections: countInjections(p.promptInjections),
      templates: countTemplates(p.promptPresets),
    },
  };
}

export function normalizeKeep(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return DEFAULT_KEEP;
  return Math.min(30, Math.max(1, n));
}

// entries: snapshot metas, newest first. Returns which to keep and which
// to delete once `keep` is enforced.
export function pruneSnapshotList(entries, keep) {
  const limit = normalizeKeep(keep);
  const sorted = [...(entries || [])].sort((a, b) =>
    String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
  );
  return { keep: sorted.slice(0, limit), remove: sorted.slice(limit) };
}
