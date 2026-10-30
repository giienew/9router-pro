// Semantic (similar-prompt) cache (R13, 9Router Pro, original code).
// Sits ON TOP of the exact cache in src/lib/responseCache.js: only for
// requests the exact cache would accept (non-streaming chat, no tools),
// plus two hard guards — opt-in only (settings.responseCache.semantic)
// and NEVER across keys (scope = sha256 of the caller API key + model).
// Non-repeatable requests are excluded by the same cacheability check
// the exact cache uses. Similarity = Jaccard over content words (with a
// small stopword list); default threshold 0.8 — similar, not paraphrase.
import { createHash } from "node:crypto";

export const DEFAULT_SEMANTIC_THRESHOLD = 0.8;
export const DEFAULT_SEMANTIC_TTL_SECONDS = 3600;
export const DEFAULT_SEMANTIC_MAX_PER_SCOPE = 100;

const STOPWORDS = new Set("a an the is are was were be been to of in on for with and or you your what how why when please give me my".split(" "));

export function scopeForKey(apiKeyValue) {
  if (!apiKeyValue) return "nokey";
  return createHash("sha256").update(String(apiKeyValue)).digest("hex");
}

export function extractPromptText(body) {
  if (!body || !Array.isArray(body.messages)) return null;
  const users = body.messages.filter((m) => m?.role === "user");
  const last = users[users.length - 1];
  if (!last) return null;
  if (typeof last.content === "string") return last.content;
  if (Array.isArray(last.content)) {
    return last.content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join(" ");
  }
  return null;
}

export function tokenize(text) {
  if (typeof text !== "string") return new Set();
  const words = text.toLowerCase().match(/[a-z0-9]{2,}/g) || [];
  return new Set(words.filter((w) => !STOPWORDS.has(w)));
}

export function promptSimilarity(a, b) {
  const A = tokenize(a);
  const B = tokenize(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

export function isSemanticCacheable(body) {
  if (!body || typeof body !== "object") return false;
  if (body.stream === true) return false;
  if (body.tools || body.tool_choice || body.functions) return false;
  if (typeof body.model !== "string" || !body.model) return false;
  return !!extractPromptText(body);
}

export function findSimilarEntry(entries, prompt, threshold = DEFAULT_SEMANTIC_THRESHOLD) {
  let best = null;
  for (const e of entries || []) {
    const sim = promptSimilarity(prompt, e.prompt || "");
    if (sim >= threshold && (!best || sim > best.similarity)) best = { ...e, similarity: sim };
  }
  return best;
}

function ensureTable(db) {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS semanticCache (key TEXT PRIMARY KEY, scopeKey TEXT NOT NULL, model TEXT NOT NULL, prompt TEXT NOT NULL, response TEXT NOT NULL, createdAt TEXT NOT NULL, expiresAt TEXT NOT NULL)`);
  } catch {}
}

export async function getSemanticEntries(db, scopeKey, model) {
  if (!db) return [];
  try {
    ensureTable(db);
    const now = new Date().toISOString();
    const rows = db.all(`SELECT prompt, response, expiresAt FROM semanticCache WHERE scopeKey = ? AND model = ? AND expiresAt >= ? ORDER BY createdAt DESC LIMIT 200`, [scopeKey, model, now]);
    return (rows || []).map((r) => {
      try { return { prompt: r.prompt, response: JSON.parse(r.response) }; } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

export async function findSemanticHit(db, scopeKey, model, prompt, threshold = DEFAULT_SEMANTIC_THRESHOLD) {
  const entries = await getSemanticEntries(db, scopeKey, model);
  return findSimilarEntry(entries, prompt, threshold);
}

export async function putSemanticEntry(db, scopeKey, model, prompt, json, ttlSeconds = DEFAULT_SEMANTIC_TTL_SECONDS, maxPerScope = DEFAULT_SEMANTIC_MAX_PER_SCOPE) {
  if (!db || !prompt || !json) return;
  try {
    ensureTable(db);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + Math.max(60, ttlSeconds || 3600) * 1000).toISOString();
    const key = createHash("sha256").update(`${scopeKey}|${model}|${prompt}`).digest("hex");
    db.run(`INSERT INTO semanticCache(key, scopeKey, model, prompt, response, createdAt, expiresAt) VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET response = excluded.response, createdAt = excluded.createdAt, expiresAt = excluded.expiresAt`, [key, scopeKey, model, prompt, JSON.stringify(json), now.toISOString(), expiresAt]);
    const count = db.get(`SELECT COUNT(*) as c FROM semanticCache WHERE scopeKey = ? AND model = ?`, [scopeKey, model])?.c ?? 0;
    if (count > Math.max(1, maxPerScope || 100)) {
      db.run(`DELETE FROM semanticCache WHERE key IN (SELECT key FROM semanticCache WHERE scopeKey = ? AND model = ? ORDER BY createdAt ASC LIMIT ?)`, [scopeKey, model, count - maxPerScope]);
    }
  } catch (e) {
    console.warn("[SemanticCache] put failed:", e?.message || e);
  }
}
