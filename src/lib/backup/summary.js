// 9Router Pro — pure helpers for backup payloads: shape check, content
// summary (counts), and snapshot retention. No I/O, no imports — the
// Settings UI numbers, the import preview and the snapshot index all
// derive from these, and they are unit-tested directly.

export const DEFAULT_KEEP = 7;

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
  return {
    valid,
    format: typeof p.format === "string" ? p.format : null,
    appVersion: typeof p.appVersion === "string" ? p.appVersion : null,
    exportedAt: typeof p.exportedAt === "string" ? p.exportedAt : null,
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
