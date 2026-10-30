import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings, getProxyPools } from "@/lib/localDb";
import { resolveConnectionProxyConfig, pickProxyPoolId, resolveRotationPoolIds } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil, connectionHealthTier, pickWindowedLru, shouldStampUnavailable, lastUsedOverlay, stampLastUsedOverlay } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS, BALANCED_WINDOW_SIZE, UNAVAILABLE_LABEL_MIN_COOLDOWN_MS, SUSPECT_PROBATION_MS, SMALL_FLEET_RESCUE_MAX_CONNECTIONS, SMALL_FLEET_RESCUE_MAX_WAIT_MS, LAST_USED_FLUSH_DELAY_MS, LAST_USED_FLUSH_MAX_BATCH } from "open-sse/config/errorConfig.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { getAntigravityQuotaCache, getAntigravityModelQuota } from "./antigravityQuota.js";
import * as log from "../utils/logger.js";

// Dedicated mutex chain for round-robin / sticky-random account selection
// (they mutate shared sticky state). It is a SEPARATE chain that no other
// strategy touches: previously every request overwrote the shared chain
// link, so a round-robin pick could capture a balanced request's link and
// run concurrently with an earlier round-robin pick, double-picking the
// same account. Balanced picks stay lock-free (see below) and never queue
// behind another request's selection.

// Sticky-random current key per provider+model (9Router Pro): the key a
// successful request sticks to until it locks. In-memory only — a restart
// cold-starts to a fresh random pick. The entry is dropped the moment its
// key locks, so the next pick re-rolls instead of re-sticking to a stale
// key. Recency alone cannot serve as the signal: after the current key
// dies, the most-recently-used available key is a stale one.
// Single-process assumption: sticky routing state lives here per process;
// under multi-process, rotation/stickiness diverge per process.
const stickyCurrentByRoute = new Map();
function stickyRouteKey(providerId, model) {
  return `${providerId}:${model || ""}`;
}
export function resetStickyCurrent() {
  stickyCurrentByRoute.clear();
}
let stickySelectionMutex = Promise.resolve();

// Deferred lastUsedAt persistence for lock-free balanced picks. The pick
// stamps the in-memory overlay synchronously (that is what keeps
// concurrent picks spread across distinct keys); the DB write only feeds
// restarts and the dashboard, so it is coalesced here and flushed in the
// background instead of blocking the request before it calls upstream.
// A failed flush is logged and dropped: the overlay still holds the
// stamp in memory, so rotation stays correct until restart.
const lastUsedDirty = new Map();
let lastUsedFlushTimer = null;

// Auto-quarantine (9Router Pro): a credential that fails auth repeatedly
// is dead, not unlucky — per-model locks alone would retry it forever
// across models. After QUARANTINE_AFTER_AUTH_FAILURES consecutive 401/403s
// the account is deactivated with a dashboard-visible reason (lastError)
// and can be re-enabled by hand (which resets the counter).
const QUARANTINE_AFTER_AUTH_FAILURES = 5;

// Provider-wide auth-failure guard: if several distinct accounts of one
// provider fail auth within a short window, the provider itself is sick
// (endpoint change, global outage) — quarantining each account would
// empty the fleet on a false signal. While the burst lasts, the counter
// freezes instead of counting provider noise as account death.
const PROVIDER_AUTH_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const PROVIDER_AUTH_FAILURE_DISTINCT_LIMIT = 5;
const providerAuthFailures = new Map(); // providerId -> Map(accountId -> timestamp)
function providerAuthFailureIsBroad(providerId, connectionId) {
  const now = Date.now();
  let perAccount = providerAuthFailures.get(providerId);
  if (!perAccount) {
    perAccount = new Map();
    providerAuthFailures.set(providerId, perAccount);
  }
  perAccount.set(connectionId, now);
  for (const [id, at] of perAccount) {
    if (now - at > PROVIDER_AUTH_FAILURE_WINDOW_MS) perAccount.delete(id);
  }
  return perAccount.size >= PROVIDER_AUTH_FAILURE_DISTINCT_LIMIT;
}
function scheduleLastUsedFlush(id, lastUsedAt, consecutiveUseCount) {
  if (!id) return;
  lastUsedDirty.set(id, { lastUsedAt, consecutiveUseCount });
  if (lastUsedDirty.size >= LAST_USED_FLUSH_MAX_BATCH) {
    void flushLastUsed();
    return;
  }
  if (!lastUsedFlushTimer) {
    lastUsedFlushTimer = setTimeout(() => {
      lastUsedFlushTimer = null;
      void flushLastUsed();
    }, LAST_USED_FLUSH_DELAY_MS);
    if (typeof lastUsedFlushTimer.unref === "function") lastUsedFlushTimer.unref();
  }
}
async function flushLastUsed() {
  if (lastUsedDirty.size === 0) return;
  const batch = [...lastUsedDirty.entries()];
  lastUsedDirty.clear();
  for (const [id, data] of batch) {
    try {
      await updateProviderConnection(id, data);
    } catch (err) {
      log.warn("AUTH", `lastUsed flush failed for ${String(id).slice(0, 8)}: ${err?.message || err}`);
    }
  }
}

const GITHUB_MONTHLY_USAGE_LIMIT = "you've reached your additional usage limit for your plan";

function githubMonthlyResetMs(status, errorText, provider) {
  if (resolveProviderId(provider) !== "github" || Number(status) !== 402) return null;
  if (!String(errorText || "").toLowerCase().includes(GITHUB_MONTHLY_USAGE_LIMIT)) return null;
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  const requestedModel = options?.requestedModel || model;
  // Strategy is resolved before any lock (settings is one small row).
  // Only round-robin and sticky-random mutate shared sticky state, so
  // only they join the dedicated sticky chain: lock first, then read.
  // Every other branch only reads (balanced stamps the in-memory overlay
  // synchronously) and touches no mutex at all, so those requests never
  // queue behind another request's selection and can never break the
  // sticky chain. The chain link is resolved in finally, so the chain
  // can never stall.
  // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
  const providerId = resolveProviderId(provider);
  const settings = await getSettings();
  const providerOverride = (settings.providerStrategies || {})[providerId] || {};
  const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "balanced";
  let resolveStickyMutex;
  if (strategy === "round-robin" || strategy === "sticky-random") {
    const currentMutex = stickySelectionMutex;
    stickySelectionMutex = new Promise(resolve => { resolveStickyMutex = resolve; });
    await currentMutex;
  }

  try {
    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const override = providerOverride;
      const strategy = override.rotateStrategy || "none";
      let pickedId = override.proxyPoolId || null;
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        const poolIds = resolveRotationPoolIds(allPools, override.proxyPoolIds);
        pickedId = pickProxyPoolId(poolIds, strategy, providerId);
      }
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" });
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
          strictProxy: resolvedProxy.strictProxy === true,
        },
      };
    }

    const connections = await getProviderConnections({ provider: providerId, isActive: true });
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // Antigravity quota cache is lazy: only populated after that account returns 409/429.
    const isAntigravity = providerId === "antigravity";
    const antigravityQuotaCache = isAntigravity && model ? getAntigravityQuotaCache() : null;

    // Filter out model-locked, excluded, and Antigravity quota-exhausted connections.
    let availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      const enabled = c.providerSpecificData?.enabledModels;
      if (providerId === "codex" && Array.isArray(enabled) && enabled.length && requestedModel && !enabled.includes(requestedModel)) return false;
      // Antigravity: skip if live quota exhausted for this model
      if (isAntigravity && model && antigravityQuotaCache) {
        const connQuotas = antigravityQuotaCache.get(c.id);
        const quota = getAntigravityModelQuota(connQuotas, model) || connQuotas?.[model];
        if (quota && quota.remainingPercentage <= 0 && quota.resetAt && new Date(quota.resetAt).getTime() > Date.now()) {
          const account = c.id?.slice(0, 8) || "unknown";
          log.info("AG_QUOTA", `${account} | CACHE_BLOCK ${model} — skip upstream until ${quota.resetAt}`);
          return false;
        }
      }
      return true;
    });

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest persistent lock or lazy Antigravity quota-cache reset for retry timing.
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      if (isAntigravity && model && antigravityQuotaCache) {
        connections.forEach((c) => {
          const connQuotas = antigravityQuotaCache.get(c.id);
          const quota = getAntigravityModelQuota(connQuotas, model) || connQuotas?.[model];
          const resetAt = quota?.resetAt;
          if (resetAt && new Date(resetAt).getTime() > Date.now()) expiries.push(resetAt);
        });
      }
      const earliest = expiries.sort()[0] || null;
      // Small-fleet rescue (9Router Pro): every connection is locked, but
      // the fleet is tiny and the earliest lock lifts soon — retry that
      // account instead of failing the request. A lock is a heuristic (a
      // quota window, a transient error); for a 1–8 account provider one
      // window must not read as a total outage. Never rescues an account
      // this request already tried, and never Antigravity, whose quota
      // cache is authoritative rather than a heuristic.
      if (!isAntigravity && earliest && connections.length <= SMALL_FLEET_RESCUE_MAX_CONNECTIONS) {
        const waitMs = new Date(earliest).getTime() - Date.now();
        const rescued = lockedConns
          .filter(c => !excludeSet.has(c.id))
          .sort((a, b) => new Date(getEarliestModelLockUntil(a)) - new Date(getEarliestModelLockUntil(b)))[0];
        if (rescued && waitMs <= SMALL_FLEET_RESCUE_MAX_WAIT_MS) {
          log.warn("AUTH", `${provider} | small-fleet rescue: retrying ${rescued.id?.slice(0, 8)} despite lock (${formatRetryAfter(earliest)})`);
          availableConnections = [rescued];
        }
      }
      if (availableConnections.length === 0 && earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      if (availableConnections.length === 0) {
        log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
        return null;
      }
    }

    // settings / providerOverride / strategy were resolved before the lock
    // above and are reused here (no second settings read).

    let connection;
    // Pin to preferred connection if specified and available
    if (preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    if (connection) {
      // skip strategy
    } else if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...availableConnections].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...availableConnections].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else if (strategy === "sticky-random") {
      // Sticky-random: stick to the current key while it keeps succeeding;
      // when it locks, re-roll randomly among the available keys. The map
      // entry is the only current signal — a stale entry never sticks,
      // because markAccountUnavailable drops the entry of a locked key.
      const routeKey = stickyRouteKey(providerId, model);
      const stickyId = stickyCurrentByRoute.get(routeKey);
      connection = stickyId ? availableConnections.find((c) => c.id === stickyId) : undefined;
      if (!connection) {
        connection = availableConnections[Math.floor(Math.random() * availableConnections.length)];
      }
      if (connection) {
        const isFreshPick = connection.id !== stickyId;
        stickyCurrentByRoute.set(routeKey, connection.id);
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: isFreshPick ? 1 : (connection.consecutiveUseCount || 0) + 1
        });
      }
    } else if (strategy === "balanced") {
      // Balanced, lock-free (9Router Pro): clean accounts first — an
      // account that failed recently and has not proven itself since
      // only serves when no clean account is available. Within the tier,
      // the pick is a random choice among the least-recently-used window,
      // so load spreads evenly from a handful of accounts to tens of
      // thousands, no account is the deterministic hot spot, and every
      // account rests while the window ahead of it drains. The pick
      // reads the in-memory overlay and stamps it synchronously, so
      // concurrent picks spread across distinct keys instead of piling
      // onto the same window while a DB write is still in flight; the
      // DB stamp itself is deferred and coalesced (scheduleLastUsedFlush)
      // so no request ever waits on a write before calling upstream.
      const now = Date.now();
      const clean = availableConnections.filter(c => connectionHealthTier(c, now, SUSPECT_PROBATION_MS) === 0);
      const tier = clean.length > 0 ? clean : availableConnections;
      connection = pickWindowedLru(tier, BALANCED_WINDOW_SIZE, Math.random, lastUsedOverlay);
      if (connection) {
        stampLastUsedOverlay(connection.id, now);
        scheduleLastUsedFlush(connection.id, new Date(now).toISOString(), 1);
      }
    } else {
      // fill-first (already sorted by priority in getProviderConnections)
      connection = availableConnections[0];
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        strictProxy: resolvedProxy.strictProxy === true,
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    if (resolveStickyMutex) resolveStickyMutex();
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  // Sticky-random: a locked key stops being current for its route, so the
  // next pick re-rolls instead of re-sticking to it. Only the entry that
  // actually points at this key is dropped.
  if (provider) {
    const routeKey = stickyRouteKey(resolveProviderId(provider), model);
    if (stickyCurrentByRoute.get(routeKey) === connectionId) stickyCurrentByRoute.delete(routeKey);
  }
  // Fail open: a locked or busy DB must not kill the request. If the read
  // fails, the lock just won't persist — the caller still falls back on
  // the cooldown computed from the status alone.
  let connections = [];
  try {
    connections = await getProviderConnections({ provider });
  } catch (err) {
    log.warn("AUTH", `getProviderConnections failed during markAccountUnavailable, continuing without persisted lock: ${err?.message || err}`);
  }
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  // GitHub premium-request exhaustion is account-wide until the next UTC month.
  const githubResetAtMs = githubMonthlyResetMs(status, errorText, provider);

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel;
  if (githubResetAtMs) {
    shouldFallback = true;
    cooldownMs = githubResetAtMs - Date.now();
    newBackoffLevel = 0;
  } else if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    // Antigravity quota API provides exact per-model resetAt. Do not truncate it.
    cooldownMs = resolveProviderId(provider) === "antigravity"
      ? resetsAtMs - Date.now()
      : Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel, resolveProviderId(provider)));
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  const reason = typeof errorText === "string" ? errorText.slice(0, 200) : "Provider error";
  const lockUpdate = buildModelLockUpdate(githubResetAtMs ? null : model, cooldownMs);

  const update = {
    ...lockUpdate,
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel
  };
  // The "unavailable" label outlives the lock itself, so only a substantial
  // cooldown earns it (9Router Pro). A seconds-long transient lock must not
  // brand a healthy account as dead on the dashboard.
  if (shouldStampUnavailable(cooldownMs, UNAVAILABLE_LABEL_MIN_COOLDOWN_MS)) {
    update.testStatus = "unavailable";
  }

  // Account-level auth-failure quarantine: 401/403 only (402 is payment,
  // 404 is a missing model — neither proves a dead credential). Only
  // counted when the connection row actually loaded; a failed DB read
  // must not clobber the true counter with a fresh 1. Success resets
  // the counter (clearAccountError); manual re-enable resets it too.
  if (conn && (status === 401 || status === 403)) {
    const providerId = provider ? resolveProviderId(provider) : null;
    const broad = providerId ? providerAuthFailureIsBroad(providerId, connectionId) : false;
    if (!broad) {
      const failures = (conn.consecutiveAuthFailures || 0) + 1;
      update.consecutiveAuthFailures = failures;
      if (failures >= QUARANTINE_AFTER_AUTH_FAILURES) {
        update.isActive = false;
        update.quarantinedAt = new Date().toISOString();
        update.quarantineReason = `Auto-quarantined after ${failures} consecutive auth failures (last: ${status})`;
        update.lastError = update.quarantineReason;
        update.testStatus = "unavailable";
      }
    }
  }

  try {
    await updateProviderConnection(connectionId, update);
  } catch (err) {
    // Fail open: the lock is lost, but the request still falls back below
    // instead of dying on a busy database.
    log.warn("AUTH", `persisting lock for ${String(connectionId).slice(0, 8)} failed, continuing in-memory only: ${err?.message || err}`);
  }

  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  const statusWords = log.describeStatus?.(status) || "";
  log.warn("AUTH", `${connName} · ${status}${statusWords ? ` ${statusWords}` : ""} · ${model || "all models"} locked ${log.fmtDuration?.(cooldownMs) || `${Math.round(cooldownMs / 1000)}s`}`);

  if (provider && status && reason) {
    // Plain words only (9Router Pro): the raw reason is an upstream JSON
    // body — the operator needs its one human sentence, not the dump.
    console.error(`❌ ${provider} [${status}]: ${log.plainErrorDetail?.(reason) || statusWords || "error"}`);
  }

  return { shouldFallback: true, cooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, {
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0
    });
  }

  // A success proves the credential alive: the auth-failure counter
  // resets even when other models' locks remain.
  if (conn.consecutiveAuthFailures) clearObj.consecutiveAuthFailures = 0;

  await updateProviderConnection(connectionId, clearObj);
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
