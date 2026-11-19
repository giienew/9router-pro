// Per-model rate limit (9Router Pro, pro.29 item D) — in-memory,
// session-scoped, per-provider+model admission control for CUSTOM
// providers (user-created OpenAI/Anthropic-compatible nodes), so one
// hot model cannot drain a provider's quota.
//
// Why this exists: Pro's priority use cases are (1) selling API access
// and (3) managing farmed API keys. A runaway agent loop (or one heavy
// API customer) hammering a single model on a custom provider burns
// that provider's quota for everyone else. This limiter caps each
// model separately: a hot model is skipped / fails over to the next
// combo member, while every other model on the same provider keeps
// serving.
//
// Scope: one bucket per (scope, provider, model). Scope is, in order:
//   1. the client session id (threaded on clientRawRequest.sessionId by
//      handleChatImpl — only when the client actually sent a stable one),
//   2. a short non-reversible hash of the router API key (one API
//      customer = one budget per model — the selling-API-access case),
//   3. a shared bucket when neither is known.
// So one customer's hot model never blocks another customer's (or
// another session's) use of the same model, and one hot model never
// blocks a different model on the same provider.
//
// Safety: in-memory only (no DB schema change, no new dependency, no
// timer/polling loop — stale entries are pruned lazily on access, like
// keyRateLimiter.js). Windows reset on restart, which is the correct
// behaviour for a rate limiter. Defaults are deliberately generous for
// a busy agent client (Hermes/OpenClaw send ~1 request per turn, turns
// are sequential): 120 requests per 60s per model — normal traffic
// never notices it; a tight retry loop hits it within a minute and
// fails over. Every function fails open (returns "allowed") on bad
// input instead of ever breaking chat. Never throws.

export const PER_MODEL_RATE_LIMIT_DEFAULT_LIMIT = 120;
export const PER_MODEL_RATE_LIMIT_DEFAULT_WINDOW_MS = 60_000;
export const PER_MODEL_RATE_LIMIT_MAX_BUCKETS = 5000;
const MAX_LIMIT = 10000;
const MIN_WINDOW_MS = 1000;
const MAX_WINDOW_MS = 3600_000;

const OPENAI_COMPATIBLE_PREFIX = "openai-compatible-";
const ANTHROPIC_COMPATIBLE_PREFIX = "anthropic-compatible-";

// provider\0model\0scope -> { times: number[] } (ascending; pruned on access)
const buckets = new Map();

export function isCustomProviderId(providerId) {
  return (
    typeof providerId === "string" &&
    (providerId.startsWith(OPENAI_COMPATIBLE_PREFIX) ||
      providerId.startsWith(ANTHROPIC_COMPATIBLE_PREFIX))
  );
}

function bucketKey(provider, model, scope) {
  return `${provider}\0${model}\0${scope || "shared"}`;
}

// Bucketing-only hash of a router API key: lets the limiter scope per
// API customer without ever storing (or logging) the key itself. djb2,
// not a security hash — a collision only shares a budget, it leaks
// nothing. The raw key never appears in any bucket key or return value.
function hashApiKey(apiKey) {
  let h = 5381;
  for (let i = 0; i < apiKey.length; i++) {
    h = ((h << 5) + h + apiKey.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// Session id wins (one conversation = one budget); otherwise the API
// key identifies the customer; otherwise every caller shares one bucket
// for that provider+model (still per-model, still bounded).
export function resolvePerModelScope({ sessionId = null, apiKey = null } = {}) {
  if (typeof sessionId === "string" && sessionId.trim()) {
    return `session:${sessionId.trim()}`;
  }
  if (typeof apiKey === "string" && apiKey.trim()) {
    return `key:${hashApiKey(apiKey.trim())}`;
  }
  return "shared";
}

function toPositiveInt(value, fallback) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Config resolution (settings.perModelRateLimit, all optional):
//   { enabled, limit, windowMs, overrides: { [provider]: {...},
//     ["provider/model"]: {...} } }
// Precedence: per-model override > per-provider override > global >
// defaults. `enabled: false` or `limit: 0` disables the limiter for
// that scope. Values are clamped so a typo cannot wedge chat
// (limit 1..10000, window 1s..1h). Missing settings = defaults.
export function resolvePerModelRateLimit(settings, provider, model) {
  const cfg = settings?.perModelRateLimit;
  const overrides = cfg?.overrides;
  const scoped =
    (provider && model && overrides?.[`${provider}/${model}`]) ||
    (provider && overrides?.[provider]) ||
    null;
  const merged = { ...(cfg || {}), ...(scoped || {}) };
  if (merged.enabled === false || merged.limit === 0) {
    return { enabled: false, limit: 0, windowMs: PER_MODEL_RATE_LIMIT_DEFAULT_WINDOW_MS };
  }
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, toPositiveInt(merged.limit, PER_MODEL_RATE_LIMIT_DEFAULT_LIMIT)),
  );
  const windowMs = Math.min(
    MAX_WINDOW_MS,
    Math.max(MIN_WINDOW_MS, toPositiveInt(merged.windowMs, PER_MODEL_RATE_LIMIT_DEFAULT_WINDOW_MS)),
  );
  return { enabled: true, limit, windowMs };
}

function prune(bucket, now, windowMs) {
  const cutoff = now - windowMs;
  let i = 0;
  while (i < bucket.times.length && bucket.times[i] <= cutoff) i++;
  if (i > 0) bucket.times.splice(0, i);
}

// Evict expired buckets first, then the oldest-inserted, so the map
// stays bounded even if callers mint unlimited provider/model/scope
// combinations. Map iteration order is insertion order.
function evictBuckets(now, windowMs) {
  if (buckets.size < PER_MODEL_RATE_LIMIT_MAX_BUCKETS) return;
  for (const [key, bucket] of buckets) {
    prune(bucket, now, windowMs);
    if (bucket.times.length === 0) buckets.delete(key);
    if (buckets.size < PER_MODEL_RATE_LIMIT_MAX_BUCKETS) return;
  }
  while (buckets.size >= PER_MODEL_RATE_LIMIT_MAX_BUCKETS) {
    buckets.delete(buckets.keys().next().value);
  }
}

// Admit one request for a provider+model in a scope. Records the
// attempt when allowed (a blocked attempt records nothing, so the
// window drains on its own). Returns { allowed, used, limit,
// windowMs, retryAfterSec, resetAtMs }. `used` counts admitted
// requests inside the current window. Never throws; bad input (or a
// disabled/zero limit) fails open to allowed.
export function tryAcquirePerModelRateLimit({
  provider,
  model,
  scope = "shared",
  limit = PER_MODEL_RATE_LIMIT_DEFAULT_LIMIT,
  windowMs = PER_MODEL_RATE_LIMIT_DEFAULT_WINDOW_MS,
  now = Date.now(),
} = {}) {
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const fallback = { allowed: true, used: 0, limit, windowMs, retryAfterSec: 0, resetAtMs: nowMs };
  try {
    if (typeof provider !== "string" || !provider || typeof model !== "string" || !model) {
      return fallback;
    }
    const safeLimit = Math.floor(Number(limit));
    if (!Number.isFinite(safeLimit) || safeLimit <= 0) return fallback;
    const safeWindow = Math.floor(Number(windowMs));
    if (!Number.isFinite(safeWindow) || safeWindow <= 0) return fallback;
    const safeNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const key = bucketKey(provider, model, scope);
    let bucket = buckets.get(key);
    if (!bucket) {
      evictBuckets(safeNow, safeWindow);
      bucket = { times: [] };
      buckets.set(key, bucket);
    }
    prune(bucket, safeNow, safeWindow);
    // Admission keeps the ring bounded by construction: an admit only
    // happens while used < limit, and prune drops everything older
    // than the window, so times.length never exceeds limit.
    if (bucket.times.length < safeLimit) {
      bucket.times.push(safeNow);
      return { allowed: true, used: bucket.times.length, limit: safeLimit, windowMs: safeWindow, retryAfterSec: 0, resetAtMs: safeNow + safeWindow };
    }
    const resetAtMs = bucket.times[0] + safeWindow;
    return {
      allowed: false,
      used: bucket.times.length,
      limit: safeLimit,
      windowMs: safeWindow,
      retryAfterSec: Math.max(1, Math.ceil((resetAtMs - safeNow) / 1000)),
      resetAtMs,
    };
  } catch {
    return fallback;
  }
}

// Read-only peek: same verdict shape, records nothing.
export function peekPerModelRateLimit({
  provider,
  model,
  scope = "shared",
  limit = PER_MODEL_RATE_LIMIT_DEFAULT_LIMIT,
  windowMs = PER_MODEL_RATE_LIMIT_DEFAULT_WINDOW_MS,
  now = Date.now(),
} = {}) {
  try {
    if (typeof provider !== "string" || !provider || typeof model !== "string" || !model) {
      return { allowed: true, used: 0, limit, windowMs, retryAfterSec: 0, resetAtMs: now };
    }
    const bucket = buckets.get(bucketKey(provider, model, scope));
    if (!bucket) return { allowed: true, used: 0, limit, windowMs, retryAfterSec: 0, resetAtMs: now };
    const safeNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const safeWindow = Number.isFinite(Number(windowMs)) && Number(windowMs) > 0 ? Number(windowMs) : PER_MODEL_RATE_LIMIT_DEFAULT_WINDOW_MS;
    prune(bucket, safeNow, safeWindow);
    const used = bucket.times.length;
    if (used < limit) return { allowed: true, used, limit, windowMs: safeWindow, retryAfterSec: 0, resetAtMs: safeNow + safeWindow };
    const resetAtMs = bucket.times[0] + safeWindow;
    return { allowed: false, used, limit, windowMs: safeWindow, retryAfterSec: Math.max(1, Math.ceil((resetAtMs - safeNow) / 1000)), resetAtMs };
  } catch {
    return { allowed: true, used: 0, limit, windowMs, retryAfterSec: 0, resetAtMs: now };
  }
}

// Test seam + introspection (bucket count only — never timestamps/keys).
export function __resetPerModelRateLimit() {
  buckets.clear();
}

export function __perModelRateLimitBucketCount() {
  return buckets.size;
}
