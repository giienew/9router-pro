// OpenAI-compatible error types mapping (client-facing)
export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "insufficient_quota" },
  404: { type: "invalid_request_error", code: "model_not_found" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "server_error", code: "internal_server_error" },
  502: { type: "server_error", code: "bad_gateway" },
  503: { type: "server_error", code: "service_unavailable" },
  504: { type: "server_error", code: "gateway_timeout" }
};

// Default error messages per status code (client-facing)
export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "You exceeded your current quota",
  404: "Model not found",
  406: "Model not supported",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout"
};

// Exponential backoff config for rate limits
export const BACKOFF_CONFIG = {
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15
};

// Default cooldown for transient/unknown errors
export const TRANSIENT_COOLDOWN_MS = 30 * 1000;

// Hard cap for provider-reported rate limit cooldown (e.g. codex resets_at can be 5-6h)
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

// Balanced selection (9Router Pro): how many least-recently-used candidates
// the picker randomizes over. Big enough to smooth bursts, small enough to
// keep the fleet's rest gradient steep.
export const BALANCED_WINDOW_SIZE = 32;

// LRU sort keys for the windowed pick: a never-used connection sorts
// before every real timestamp (all real timestamps are positive ms since
// epoch, far above this base), ordered by priority number ascending.
// Priority is clamped so the sum can never reach a real timestamp.
export const LRU_NEVER_USED_BASE = -1e15;
export const LRU_PRIORITY_CAP = 1e12;

// In-memory last-used overlay: hard cap on entries, and entries older
// than this are pruned once the cap is hit (their DB stamp is the source
// of truth by then, so dropping them only loses a stale hint).
export const LAST_USED_OVERLAY_MAX_ENTRIES = 100000;
export const LAST_USED_OVERLAY_PRUNE_AGE_MS = 3600 * 1000;

// Deferred lastUsedAt flush: coalesce picked keys this long before
// writing them, or flush immediately once this many are dirty.
export const LAST_USED_FLUSH_DELAY_MS = 5000;
export const LAST_USED_FLUSH_MAX_BATCH = 1000;

// Least-busy routing (9Router Pro): pick the eligible connection with the
// lowest live load instead of spreading evenly. The load signal is cheap
// and bounded: in-flight picks counted in memory at selection time, plus
// recent failures inside a short window. No timer, no polling, no new
// dependency — stale in-flight entries age out lazily on the next read, so
// an outcome that never reports (aborted stream, flaky retry) stops
// counting after the stale window instead of wedging a key forever.
export const LEAST_BUSY_IN_FLIGHT_WEIGHT = 10;
export const LEAST_BUSY_RECENT_ERROR_WEIGHT = 4;
export const LEAST_BUSY_RECENT_ERROR_WINDOW_MS = 5 * 60 * 1000;
export const LEAST_BUSY_IN_FLIGHT_STALE_MS = 10 * 60 * 1000;
export const LEAST_BUSY_MAX_ENTRIES = 8192;
export const LEAST_BUSY_MAX_ERRORS_PER_KEY = 16;
export const LEAST_BUSY_MAX_IN_FLIGHT_PER_KEY = 64;

// A failure only earns the dashboard "unavailable" label when its cooldown
// is at least this long. Short transient locks (seconds) must not brand a
// healthy key as dead — the label outlives the lock and misleads operators.
export const UNAVAILABLE_LABEL_MIN_COOLDOWN_MS = 60 * 1000;

// A suspect (recently failed) connection returns to the clean tier when its
// last failure is older than this, even without new traffic — fleets heal
// on their own instead of shrinking forever.
export const SUSPECT_PROBATION_MS = 60 * 60 * 1000;

// Provider breaker (P3-27, 9Router Pro): the third resilience layer. When a
// provider's fleet fails broadly, the whole provider stops receiving
// traffic for a minute instead of every request hammering it, then re-opens
// for a short probing window. Distinct from connection cooldown (one
// account) and model lockout (one model on one account): this is
// provider-wide. Auth failures (401/403) never trip it — those are
// credential problems, handled by quarantine, not outages.
export const PROVIDER_BREAKER_WINDOW_MS = 5 * 60 * 1000;
export const PROVIDER_BREAKER_MIN_FAILURES = 5;
export const PROVIDER_BREAKER_MIN_CONNECTIONS = 2;
// Provider-wide trip bar (raised 2026-11-18, twice): the provider trip
// is the blunt instrument — it parks EVERY model of a provider. It must
// fire only on a genuinely broad outage, not on a burst. A burst of
// 5 failures from 2 keys used to trip it; 15/5 (first retune) STILL
// tripped under Hermes' load — dahl's flaky models fail often enough
// that 15 failures from 5 keys in 5 min is routine, and it parked the
// healthy models too. The per-model cooldown (MIN_FAILURES /
// MIN_CONNECTIONS above) still parks a single bad model fast — the
// provider bar is deliberately far higher, a last resort for a
// catastrophic all-models-down outage only.
export const PROVIDER_BREAKER_PROVIDER_MIN_FAILURES = 50;
export const PROVIDER_BREAKER_PROVIDER_MIN_CONNECTIONS = 10;
// Half-open probe tolerance (2026-11-18): the probe window used to
// re-open on the FIRST failure, so a flaky-but-mostly-up provider
// almost never recovered — every probe window re-opened on one unlucky
// request. Now the probe tolerates one failure and only re-opens on
// the second; a success still closes immediately, and a quiet window
// still closes.
export const PROVIDER_BREAKER_PROBE_MAX_FAILURES = 2;
export const PROVIDER_BREAKER_OPEN_MS = 60 * 1000;
export const PROVIDER_BREAKER_PROBE_MS = 30 * 1000;
// Per-model cooldown ceiling: a model that keeps failing escalates
// 60s → 120s → 240s → ... but never parks longer than 10 min at a time.
export const PROVIDER_BREAKER_MODEL_COOLDOWN_MAX_MS = 10 * 60 * 1000;

// Small-fleet rescue: when every connection of a small provider is locked
// but the earliest lock lifts within this wait, selection retries that
// connection instead of failing the request outright. Large fleets never
// need it (something is always unlocked), small ones must not hard-down
// over one transient quota window.
export const SMALL_FLEET_RESCUE_MAX_CONNECTIONS = 8;
export const SMALL_FLEET_RESCUE_MAX_WAIT_MS = 45 * 1000;

// Cooldown durations (ms)
const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
};

/**
 * Unified error classification rules.
 * Checked top-to-bottom: text rules first (by order), then status rules.
 * Each rule: { text?, status?, cooldownMs?, backoff? }
 *   - text: substring match (case-insensitive) on error message
 *   - status: HTTP status code match
 *   - cooldownMs: fixed cooldown duration
 *   - backoff: true = use exponential backoff (rate limit)
 */
export const ERROR_RULES = [
  // --- Text-based rules (checked first, order = priority) ---
  { provider: "codex", text: "model is not supported when using codex with a chatgpt account", cooldownMs: MAX_RATE_LIMIT_COOLDOWN_MS },
  // Intl gateway blocks affect the account/IP, so let the connection back off.
  { provider: "codebuddy-intl", text: "request illegal", backoff: true },
  { provider: "codebuddy-intl", text: "conversation id missing", backoff: true },
  { text: "no credentials",           cooldownMs: COOLDOWN.long },
  { text: "request not allowed",      cooldownMs: COOLDOWN.short },
  { text: "improperly formed request", cooldownMs: COOLDOWN.long },
  { text: "rate limit",               backoff: true },
  { text: "too many requests",        backoff: true },
  { text: "quota exceeded",           backoff: true },
  { text: "insufficient credit",      backoff: true },
  { text: "credit balance is too low", backoff: true },
  { text: "capacity",                 backoff: true },
  { text: "overloaded",               backoff: true },

  // --- Status-based rules (fallback when text doesn't match) ---
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: COOLDOWN.long },
  { status: 403, cooldownMs: COOLDOWN.long },
  { status: 404, cooldownMs: COOLDOWN.long },
  { status: 429, backoff: true },
];

// Backward compat: COOLDOWN_MS object (used by index.js re-export)
export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
};
