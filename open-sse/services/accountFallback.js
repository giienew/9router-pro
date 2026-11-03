import { ERROR_RULES, BACKOFF_CONFIG, TRANSIENT_COOLDOWN_MS, LRU_NEVER_USED_BASE, LRU_PRIORITY_CAP, LAST_USED_OVERLAY_MAX_ENTRIES, LAST_USED_OVERLAY_PRUNE_AGE_MS } from "../config/errorConfig.js";

/**
 * Calculate exponential backoff cooldown for rate limits (429)
 * Level 1: 1s, Level 2: 2s, Level 3: 4s... → max 4 min
 * @param {number} backoffLevel - Current backoff level
 * @returns {number} Cooldown in milliseconds
 */
export function getQuotaCooldown(backoffLevel = 0) {
  const level = Math.max(0, backoffLevel - 1);
  const cooldown = BACKOFF_CONFIG.base * Math.pow(2, level);
  return Math.min(cooldown, BACKOFF_CONFIG.max);
}

/**
 * Check if error should trigger account fallback (switch to next account)
 * Config-driven: matches ERROR_RULES top-to-bottom (text rules first, then status)
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message text
 * @param {number} backoffLevel - Current backoff level for exponential backoff
 * @returns {{ shouldFallback: boolean, cooldownMs: number, newBackoffLevel?: number, requestScoped?: boolean }}
 *
 * `shouldFallback` answers "is the CREDENTIAL at fault?" (account rotation).
 * `requestScoped` answers "is the REQUEST itself what this member rejected?"
 * (combo rotation). They are different questions: a context overflow or a
 * validation 400 means the credential is healthy but this member cannot serve
 * this request, so combo rotation must still try the next member.
 */
// Statuses with their own rule keep rule order; every other 4xx is
// request-scoped (see the short-circuit in checkFallbackError).
const STATUS_RULE_STATUSES = new Set(ERROR_RULES.filter((r) => r.status).map((r) => r.status));

function applyRule(rule, backoffLevel) {
  if (rule.backoff) {
    const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
    return { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel), newBackoffLevel: newLevel };
  }
  return { shouldFallback: true, cooldownMs: rule.cooldownMs };
}

export function checkFallbackError(status, errorText, backoffLevel = 0, provider = null) {
  const lowerError = errorText
    ? (typeof errorText === "string" ? errorText : JSON.stringify(errorText)).toLowerCase()
    : "";

  // Provider-specific text rules keep priority: they describe account/IP
  // blocks (e.g. an intl gateway block), not request problems.
  for (const rule of ERROR_RULES) {
    if (!rule.provider || rule.provider !== provider) continue;
    if (rule.text && lowerError && lowerError.includes(rule.text)) return applyRule(rule, backoffLevel);
  }

  // Request-scoped 4xx short-circuit BEFORE generic text rules: a 400
  // validation error whose body merely mentions "rate limit" says
  // nothing about the credential, and must not earn the account a
  // backoff lock the way a plain 400 already avoids one. Statuses with
  // their own rule (401/402/403/404/429) keep rule order below.
  if (status >= 400 && status < 500 && !STATUS_RULE_STATUSES.has(status)) {
    return { shouldFallback: false, cooldownMs: 0, requestScoped: true };
  }

  for (const rule of ERROR_RULES) {
    if (rule.provider && rule.provider !== provider) continue;
    // Text-based rule: match substring in error message
    if (rule.text && lowerError && lowerError.includes(rule.text)) {
      return applyRule(rule, backoffLevel);
    }

    // Status-based rule: match HTTP status code
    if (rule.status && rule.status === status) {
      return applyRule(rule, backoffLevel);
    }
  }

  // Request-scoped client errors that matched no rule above: a 400 caused by the
  // request itself (context overflow, malformed body, unsupported parameter) says
  // nothing about the credential, so cooling the account down only removes a
  // healthy connection from rotation. With a single connection it is worse: every
  // later request in the window fails with a copy of this very error
  // ("all 1 accounts locked for <model> | lastError=[400]: ..."), which hides the
  // real cause from the caller and makes unrelated sessions look like they hit the
  // same limit. Hand the upstream error back for this request instead.
  // Account-scoped statuses keep their rules above (401/402/403/404/429), and the
  // text rules still win for rate-limit / quota / capacity wording.
  if (status >= 400 && status < 500 && status !== 401 && status !== 402 && status !== 403 && status !== 429) {
    return { shouldFallback: false, cooldownMs: 0, requestScoped: true };
  }

  // Default: transient cooldown for any unmatched error
  return { shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS };
}

/**
 * Check if account is currently unavailable (cooldown not expired)
 */
export function isAccountUnavailable(unavailableUntil) {
  if (!unavailableUntil) return false;
  return new Date(unavailableUntil).getTime() > Date.now();
}

/**
 * Calculate unavailable until timestamp
 */
export function getUnavailableUntil(cooldownMs) {
  return new Date(Date.now() + cooldownMs).toISOString();
}

/**
 * Get the earliest rateLimitedUntil from a list of accounts
 * @param {Array} accounts - Array of account objects with rateLimitedUntil
 * @returns {string|null} Earliest rateLimitedUntil ISO string, or null
 */
export function getEarliestRateLimitedUntil(accounts) {
  let earliest = null;
  const now = Date.now();
  for (const acc of accounts) {
    if (!acc.rateLimitedUntil) continue;
    const until = new Date(acc.rateLimitedUntil).getTime();
    if (until <= now) continue;
    if (!earliest || until < earliest) earliest = until;
  }
  if (!earliest) return null;
  return new Date(earliest).toISOString();
}

/**
 * Format rateLimitedUntil to human-readable "reset after Xm Ys"
 * @param {string} rateLimitedUntil - ISO timestamp
 * @returns {string} e.g. "reset after 2m 30s"
 */
export function formatRetryAfter(rateLimitedUntil) {
  if (!rateLimitedUntil) return "";
  const diffMs = new Date(rateLimitedUntil).getTime() - Date.now();
  if (diffMs <= 0) return "reset after 0s";
  const totalSec = Math.ceil(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return `reset after ${parts.join(" ")}`;
}

/** Prefix for model lock flat fields on connection record */
export const MODEL_LOCK_PREFIX = "modelLock_";

/** Special key used when no model is known (account-level lock) */
export const MODEL_LOCK_ALL = `${MODEL_LOCK_PREFIX}__all`;

/** Build the flat field key for a model lock */
export function getModelLockKey(model) {
  return model ? `${MODEL_LOCK_PREFIX}${model}` : MODEL_LOCK_ALL;
}

/**
 * Check if a model lock on a connection is still active.
 * Reads flat field `modelLock_${model}` (or `modelLock___all` when model=null).
 */
export function isModelLockActive(connection, model) {
  const key = getModelLockKey(model);
  const expiry = connection[key] || connection[MODEL_LOCK_ALL];
  if (!expiry) return false;
  return new Date(expiry).getTime() > Date.now();
}

/**
 * Get earliest active model lock expiry across all modelLock_* fields.
 * Used for UI cooldown display.
 */
export function getEarliestModelLockUntil(connection) {
  if (!connection) return null;
  let earliest = null;
  const now = Date.now();
  for (const [key, val] of Object.entries(connection)) {
    if (!key.startsWith(MODEL_LOCK_PREFIX) || !val) continue;
    const t = new Date(val).getTime();
    if (t <= now) continue;
    if (!earliest || t < earliest) earliest = t;
  }
  return earliest ? new Date(earliest).toISOString() : null;
}

/**
 * Build update object to set a model lock on a connection.
 */
export function buildModelLockUpdate(model, cooldownMs) {
  const key = getModelLockKey(model);
  return { [key]: new Date(Date.now() + cooldownMs).toISOString() };
}

/**
 * Build update object to clear all model locks on a connection.
 */
export function buildClearModelLocksUpdate(connection) {
  const cleared = {};
  for (const key of Object.keys(connection)) {
    if (key.startsWith(MODEL_LOCK_PREFIX)) cleared[key] = null;
  }
  return cleared;
}

/**
 * Filter available accounts (not in cooldown)
 */
export function filterAvailableAccounts(accounts, excludeId = null) {
  const now = Date.now();
  return accounts.filter(acc => {
    if (excludeId && acc.id === excludeId) return false;
    if (acc.rateLimitedUntil) {
      const until = new Date(acc.rateLimitedUntil).getTime();
      if (until > now) return false;
    }
    return true;
  });
}

/**
 * Health tier of a connection for balanced selection (9Router Pro).
 * 0 = clean (no recent failure), 1 = suspect (failed recently and has not
 * proven itself since). A suspect returns to clean once its last failure
 * ages past the probation window, even without traffic, so fleets heal
 * instead of shrinking forever.
 * @param {object} connection - Flattened connection record
 * @param {number} now - Current time in ms
 * @param {number} probationMs - Suspect probation window
 * @returns {0|1}
 */
export function connectionHealthTier(connection, now = Date.now(), probationMs = 0) {
  if (!connection) return 1;
  const failed = (connection.backoffLevel || 0) > 0 || !!connection.lastError;
  if (!failed) return 0;
  if (probationMs > 0 && connection.lastErrorAt) {
    const failedAt = new Date(connection.lastErrorAt).getTime();
    if (Number.isFinite(failedAt) && now - failedAt >= probationMs) return 0;
  }
  return 1;
}

/**
 * In-memory last-used overlay for lock-free balanced picks (9Router Pro).
 * The DB stamp is flushed lazily (see scheduleLastUsedFlush in auth.js),
 * so the overlay is what concurrent picks read: a key stamped here sorts
 * to the back of the window immediately, and two requests racing in this
 * process never pile onto the same key while the DB write is still in
 * flight. Values are ms since epoch, directly comparable to Date.parse
 * of the stored ISO strings. The overlay is a pure accelerator: on
 * restart it starts empty and picks fall back to the DB timestamps.
 */
export const lastUsedOverlay = new Map();

export function stampLastUsedOverlay(id, nowMs = Date.now()) {
  if (!id) return;
  lastUsedOverlay.set(id, nowMs);
  if (lastUsedOverlay.size > LAST_USED_OVERLAY_MAX_ENTRIES) {
    const cutoff = nowMs - LAST_USED_OVERLAY_PRUNE_AGE_MS;
    for (const [key, value] of lastUsedOverlay) {
      if (value < cutoff) lastUsedOverlay.delete(key);
    }
  }
}

// LRU sort key for one connection. Never-used sorts before any used
// timestamp, ordered by priority number ascending (the old comparator's
// rule); used connections sort by timestamp ascending. Unparseable
// timestamps are treated as never-used, which is deterministic where the
// old comparator's NaN comparison was not.
function lruKey(connection, overlay) {
  if (overlay?.has(connection.id)) return overlay.get(connection.id);
  const priority = Math.min(connection.priority || 999, LRU_PRIORITY_CAP);
  if (!connection.lastUsedAt) return LRU_NEVER_USED_BASE + priority;
  const parsed = Date.parse(connection.lastUsedAt);
  return Number.isFinite(parsed) ? parsed : LRU_NEVER_USED_BASE + priority;
}

/**
 * Pick one connection from the least-recently-used window (9Router Pro).
 * Same window semantics as before — never-used first (lowest priority
 * number first), then oldest use, uniform random choice among the first
 * `windowSize` candidates so bursts spread and no key becomes the
 * deterministic hot spot — but in a single O(n) pass instead of a full
 * sort: each timestamp is parsed once, never inside a comparator. On an
 * 18k-key fleet the old sort cost ~200ms per pick; this pass costs ~6ms.
 * An optional overlay map (id -> ms) overrides stored timestamps, so a
 * just-picked key immediately leaves the window for concurrent picks.
 * @param {Array} connections - Eligible connections
 * @param {number} windowSize
 * @param {function} rng - Random source returning [0, 1)
 * @param {Map|null} overlay - Optional in-memory last-used overrides
 * @returns {object|null}
 */
export function pickWindowedLru(connections, windowSize = 32, rng = Math.random, overlay = null) {
  if (!connections?.length) return null;
  const size = Math.max(1, Math.min(windowSize, connections.length));
  const window = []; // [key, connection], ascending by key once filled
  for (const connection of connections) {
    const key = lruKey(connection, overlay);
    if (window.length < size) {
      window.push([key, connection]);
      if (window.length === size) window.sort((a, b) => a[0] - b[0]);
    } else if (key < window[size - 1][0]) {
      window[size - 1] = [key, connection];
      window.sort((a, b) => a[0] - b[0]);
    }
  }
  if (window.length < size) window.sort((a, b) => a[0] - b[0]);
  return window[Math.floor(rng() * window.length)][1];
}

/**
 * Whether a cooldown is long enough to brand the connection "unavailable"
 * on the dashboard (9Router Pro). The lock itself always applies; only
 * the label is gated, because the label outlives short locks and a key
 * stamped dead over a 30-second blip misleads operators into thinking
 * the fleet is dying.
 * @param {number} cooldownMs
 * @param {number} minCooldownMs
 * @returns {boolean}
 */
export function shouldStampUnavailable(cooldownMs, minCooldownMs) {
  return cooldownMs >= minCooldownMs;
}

/**
 * Reset account state when request succeeds
 * Clears cooldown and resets backoff level to 0
 * @param {object} account - Account object
 * @returns {object} Updated account with reset state
 */
export function resetAccountState(account) {
  if (!account) return account;
  return {
    ...account,
    rateLimitedUntil: null,
    backoffLevel: 0,
    lastError: null,
    status: "active"
  };
}

/**
 * Apply error state to account
 * @param {object} account - Account object
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message
 * @returns {object} Updated account with error state
 */
export function applyErrorState(account, status, errorText) {
  if (!account) return account;

  const backoffLevel = account.backoffLevel || 0;
  const { cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel);

  return {
    ...account,
    rateLimitedUntil: cooldownMs > 0 ? getUnavailableUntil(cooldownMs) : null,
    backoffLevel: newBackoffLevel ?? backoffLevel,
    lastError: { status, message: errorText, timestamp: new Date().toISOString() },
    status: "error"
  };
}
