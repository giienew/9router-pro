import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";
import { getSettings } from "@/lib/localDb";
import { getAdapter } from "@/lib/db/driver.js";
import { buildCacheKey, cacheableResponse, getCached, putCached } from "@/lib/responseCache.js";

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
  try {
    const settings = await getSettings();
    cacheCfg = settings.responseCache || {};
    if (cacheCfg.enabled) {
      const body = await request.clone().json();
      cacheKey = buildCacheKey(body);
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

  const res = await handleChat(request);

  if (cacheKey && cacheCfg?.enabled && res.ok) {
    try {
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const json = await res.clone().json();
        if (cacheableResponse(json)) {
          const db = await getAdapter();
          await putCached(db, cacheKey, json, cacheCfg.ttlSeconds, cacheCfg.maxEntries);
        }
        try { res.headers.set("X-9Router-Cache", "MISS"); } catch {}
      }
    } catch { /* cache write failure must never break the response */ }
  }

  return res;
}

