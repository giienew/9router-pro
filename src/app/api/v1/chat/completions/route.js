import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";
import { getSettings } from "@/lib/localDb";
import { getAdapter } from "@/lib/db/driver.js";
import { buildCacheKey, cacheableResponse, getCached, putCached } from "@/lib/responseCache.js";
import { isSemanticCacheable, extractPromptText, scopeForKey, findSemanticHit, putSemanticEntry, DEFAULT_SEMANTIC_THRESHOLD } from "@/lib/semanticCache.js";

let initialized = false;

/**
 * Initialize translators once
 */
async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

export async function POST(request) {
  // Fallback to local handling
  await ensureInitialized();

  // Response cache (opt-in, chat completions only): an identical
  // non-streaming body replays the stored JSON. The clone is parsed so the
  // original request still reaches the handler untouched on a miss.
  let cacheKey = null;
  let cacheCfg = null;
  // R13 semantic cache: same opt-in gate as the exact cache, plus its own
  // semantic.enabled flag. Scope = hash of the caller API key (never raw).
  let semanticBody = null;
  let semanticScope = null;
  try {
    const settings = await getSettings();
    cacheCfg = settings.responseCache || {};
    if (cacheCfg.enabled) {
      const body = await request.clone().json();
      cacheKey = buildCacheKey(body);
      if (cacheCfg.semantic?.enabled && isSemanticCacheable(body)) {
        semanticBody = body;
        const auth = request.headers.get("authorization") || "";
        semanticScope = scopeForKey(auth.startsWith("Bearer ") ? auth.slice(7) : null);
      }
    }
  } catch { /* unparsable body or settings error: passthrough */ }

  if (cacheKey) {
    try {
      const db = await getAdapter();
      const hit = await getCached(db, cacheKey);
      if (hit) {
        return new Response(JSON.stringify(hit), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-9Router-Cache": "HIT" },
        });
      }
    } catch { /* cache read failure must never block the request */ }
  }

  // R13: similar-prompt hit, only after the exact cache missed.
  if (semanticBody) {
    try {
      const db = await getAdapter();
      const prompt = extractPromptText(semanticBody);
      const hit = prompt ? await findSemanticHit(db, semanticScope, semanticBody.model, prompt, cacheCfg.semantic.threshold ?? DEFAULT_SEMANTIC_THRESHOLD) : null;
      if (hit) {
        return new Response(JSON.stringify(hit.response), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-9Router-Cache": "SEMANTIC" },
        });
      }
    } catch { /* semantic miss/failure must never block the request */ }
  }

  const res = await handleChat(request);

  // R2 failed-request events: server errors only, fire-and-forget.
  if (!res.ok && res.status >= 500) {
    getAdapter()
      .then(async (db) => {
        const { recordTrustEvent } = await import("@/lib/trustEvents.js");
        recordTrustEvent(db, { kind: "failed-request", level: "warn", subject: "chat", title: `Chat request failed (${res.status})`, detail: "A request through /v1/chat/completions returned a server error." });
      })
      .catch(() => {});
  }

  if (cacheKey && cacheCfg?.enabled && res.ok) {
    try {
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const json = await res.clone().json();
        if (cacheableResponse(json)) {
          const db = await getAdapter();
          await putCached(db, cacheKey, json, cacheCfg.ttlSeconds, cacheCfg.maxEntries);
          if (semanticBody) {
            const prompt = extractPromptText(semanticBody);
            if (prompt) await putSemanticEntry(db, semanticScope, semanticBody.model, prompt, json, cacheCfg.semantic?.ttlSeconds);
          }
        }
        try { res.headers.set("X-9Router-Cache", "MISS"); } catch {}
      }
    } catch { /* cache write failure must never break the response */ }
  }

  return res;
}

