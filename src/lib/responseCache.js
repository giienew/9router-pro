// Response cache (9Router Pro): exact replays for non-streaming chat
// completions. Scope is deliberately narrow — tool calls are never replayed
// (the client would re-act on stale tool calls), and streaming responses
// pass through untouched. The key covers the WHOLE request body except
// `stream`, so any parameter change is a different entry. Opt-in only.
import { createHash } from "node:crypto";

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

// Cacheable = a plain chat-completions body that will not stream and asks
// for no tools. Everything else returns null (caller passes through).
export function buildCacheKey(body) {
  if (!body || typeof body !== "object") return null;
  if (body.stream === true) return null;
  if (body.tools || body.tool_choice || body.functions) return null;
  if (typeof body.model !== "string" || !body.model) return null;
  if (!Array.isArray(body.messages) || body.messages.length === 0) return null;
  const { stream, ...rest } = body;
  return createHash("sha256").update(stableStringify(rest)).digest("hex");
}

export function cacheableResponse(json) {
  return Boolean(json && typeof json === "object" && Array.isArray(json.choices) && json.choices.length > 0);
}

export async function getCached(db, key) {
  try {
    const row = db.get(`SELECT response, expiresAt FROM responseCache WHERE key = ?`, [key]);
    if (!row) return null;
    if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) {
      try { db.run(`DELETE FROM responseCache WHERE key = ?`, [key]); } catch {}
      return null;
    }
    return JSON.parse(row.response);
  } catch {
    return null;
  }
}

export async function putCached(db, key, json, ttlSeconds, maxEntries) {
  try {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + Math.max(60, ttlSeconds || 3600) * 1000).toISOString();
    db.run(`DELETE FROM responseCache WHERE expiresAt < ?`, [now.toISOString()]);
    db.run(
      `INSERT INTO responseCache(key, response, createdAt, expiresAt) VALUES(?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET response = excluded.response, createdAt = excluded.createdAt, expiresAt = excluded.expiresAt`,
      [key, JSON.stringify(json), now.toISOString(), expiresAt],
    );
    const max = Math.max(1, maxEntries || 1000);
    const count = db.get(`SELECT COUNT(*) as c FROM responseCache`)?.c ?? 0;
    if (count > max) {
      db.run(`DELETE FROM responseCache WHERE key IN (SELECT key FROM responseCache ORDER BY createdAt ASC LIMIT ?)`, [count - max]);
    }
  } catch (e) {
    console.warn(`[ResponseCache] put failed: ${e?.message || e}`);
  }
}

export async function clearExpiredCache(db) {
  try {
    const row = db.get(`SELECT COUNT(*) as c FROM responseCache WHERE expiresAt < ?`, [new Date().toISOString()]);
    db.run(`DELETE FROM responseCache WHERE expiresAt < ?`, [new Date().toISOString()]);
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}
