// Live /v1/models feeds for OpenAI/Anthropic-compatible provider nodes.
//
// Pattern from the Go router (9router-go live catalog): a compatible
// gateway's own /models feed is the authority for context_length /
// max_completion_tokens — it beats the static pattern tables, which guess
// from the model name. The feed is cached ~5 minutes per credential and
// every failure falls back to the static registry, so a dead or silent
// gateway never empties a provider or changes a published value.
//
// Follows src/lib/modelCatalog/sync.js: AbortSignal.timeout for the fetch,
// failures swallowed on purpose, nothing thrown to callers.

import { createHash } from "node:crypto";

export const LIVE_MODEL_FEED_TTL_MS = 5 * 60 * 1000;
export const LIVE_MODEL_FEED_TIMEOUT_MS = 5000;

// Cache entries: key -> { at, data }. In-flight fetches are shared so one
// /v1/models build never fires the same feed twice.
const cache = new Map();
const inflight = new Map();

function positiveInt(value) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
}

// A gateway's /models entries carry limits under the OpenAI/OpenRouter
// snake_case names; accept the camelCase spellings too, since some
// gateways (and the Go router's own /v1/models) publish those.
function limitsOf(entry) {
  const contextWindow = positiveInt(entry?.context_length ?? entry?.context_window);
  const maxOutput = positiveInt(entry?.max_completion_tokens ?? entry?.max_output_tokens);
  if (contextWindow === undefined && maxOutput === undefined) return null;
  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutput !== undefined ? { maxOutput } : {}),
  };
}

// Parse an OpenAI-style /models payload into the ids it lists plus the
// per-model limits it declares. Models without limits are still listed —
// their limits come from the static registry downstream.
export function parseLiveModelFeed(data) {
  const raw = Array.isArray(data) ? data : (data?.data || data?.models || data?.results || []);
  const ids = [];
  const seen = new Set();
  const limits = new Map();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const id = entry?.id || entry?.name || entry?.model;
    if (typeof id !== "string" || id.trim() === "") continue;
    const modelId = id.trim();
    if (!seen.has(modelId)) {
      seen.add(modelId);
      ids.push(modelId);
    }
    const parsed = limitsOf(entry);
    if (parsed && !limits.has(modelId)) limits.set(modelId, parsed);
  }
  return { ids, limits };
}

// Upstream ids are not always spelled the way the router lists them: a
// seat may be `deepseek-ai/DeepSeek-V4-Flash-0731` while the feed lists
// the bare `DeepSeek-V4-Flash-0731`. Exact match first, then the last
// path segment.
export function findLiveLimits(limits, modelId) {
  if (!(limits instanceof Map) || typeof modelId !== "string" || modelId === "") return null;
  const exact = limits.get(modelId);
  if (exact) return exact;
  const slash = modelId.lastIndexOf("/");
  if (slash >= 0 && slash < modelId.length - 1) {
    return limits.get(modelId.slice(slash + 1)) || null;
  }
  return null;
}

// Cache key: the feed URL plus a hash of the credential, so two nodes on
// the same gateway with different keys never share each other's catalog.
// The hash is the key — the secret itself is never stored.
function cacheKey(url, headers) {
  const auth = headers?.Authorization || headers?.authorization || "";
  const apiKey = headers?.["x-api-key"] || headers?.["X-Api-Key"] || "";
  const fingerprint = createHash("sha256").update(`${auth}\n${apiKey}`).digest("hex").slice(0, 16);
  return `${url}::${fingerprint}`;
}

// Fetch one provider's live /models feed. Returns { ids, limits } or null
// on any failure (network, timeout, non-2xx, bad JSON) — callers fall back
// to the static registry. `fetchImpl` and `now` exist so tests can stub
// the network and the clock without touching globals.
export async function fetchLiveModelFeed({
  url,
  headers = {},
  fetchImpl = globalThis.fetch,
  timeoutMs = LIVE_MODEL_FEED_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  if (typeof url !== "string" || url === "") return null;
  const key = cacheKey(url, headers);
  const cached = cache.get(key);
  if (cached && now() - cached.at < LIVE_MODEL_FEED_TTL_MS) return cached.data;
  const pending = inflight.get(key);
  if (pending) return pending;

  const task = (async () => {
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers,
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response?.ok) return null;
      return parseLiveModelFeed(await response.json());
    } catch {
      return null;
    }
  })();
  inflight.set(key, task);
  try {
    const data = await task;
    if (data) {
      if (cache.size >= 500) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, { at: now(), data });
    }
    return data;
  } finally {
    inflight.delete(key);
  }
}

export function clearLiveModelFeedCache() {
  cache.clear();
  inflight.clear();
}
