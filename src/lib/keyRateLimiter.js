// Key Rate Limiter (9Router Pro) — in-memory per-API-key admission control
// for the seller limits (requests per minute/hour/day + max concurrent).
// State is process-local by design: windows reset on restart, which matches
// how rate limiters are expected to behave; the durable budget control stays
// the token quota in keyQuotaRepo (DB-backed). TPM is enforced separately as
// a soft DB check in the chat handler, like the quota. Never throws.

const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
const SLOT_TTL_MS = 15 * MIN_MS; // safety net so a leaked slot frees itself
const MAX_TIMES = 200000; // pathological-memory guard for the timestamp ring

const state = new Map(); // keyId -> { times: number[], inFlight: number }
// Single-process assumption: this state is per process. Under multi-process,
// per-key limits are enforced per process, not globally — move to SQLite for
// global enforcement.

function entry(keyId) {
  let e = state.get(keyId);
  if (!e) {
    e = { times: [], inFlight: 0 };
    state.set(keyId, e);
  }
  return e;
}

function prune(e, now) {
  const cutoff = now - DAY_MS;
  let i = 0;
  while (i < e.times.length && e.times[i] <= cutoff) i++;
  if (i > 0) e.times.splice(0, i);
  if (e.times.length > MAX_TIMES) e.times.splice(0, e.times.length - MAX_TIMES);
}

function countWithin(e, now, windowMs) {
  const cutoff = now - windowMs;
  let n = 0;
  for (let i = e.times.length - 1; i >= 0; i--) {
    if (e.times[i] <= cutoff) break;
    n++;
  }
  return n;
}

function oldestWithin(e, now, windowMs) {
  const cutoff = now - windowMs;
  for (let i = 0; i < e.times.length; i++) {
    if (e.times[i] > cutoff) return e.times[i];
  }
  return now;
}

function windowVerdict(e, limits, field, windowMs, kind, now) {
  const limit = limits?.[field];
  if (!limit) return null;
  const used = countWithin(e, now, windowMs);
  if (used < limit) return null;
  const retryAfterSec = Math.max(1, Math.ceil((oldestWithin(e, now, windowMs) + windowMs - now) / 1000));
  return { blocked: true, kind, used, limit, retryAfterSec };
}

// Decision used by the chat handler before a request is admitted.
export function peekKeyLimits(keyId, limits, now = Date.now()) {
  if (!keyId || !limits) return { blocked: false };
  const e = state.get(keyId);
  if (!e) return { blocked: false };
  prune(e, now);
  if (limits.maxConcurrent && e.inFlight >= limits.maxConcurrent) {
    return { blocked: true, kind: "concurrency", used: e.inFlight, limit: limits.maxConcurrent, retryAfterSec: 5 };
  }
  return (
    windowVerdict(e, limits, "rpm", MIN_MS, "rpm", now) ||
    windowVerdict(e, limits, "rph", HOUR_MS, "rph", now) ||
    windowVerdict(e, limits, "rpd", DAY_MS, "rpd", now) ||
    { blocked: false }
  );
}

// Record an admitted request and take a concurrency slot. Returns an
// idempotent release function; the slot also frees itself after a TTL so a
// dropped release can never wedge a key forever.
export function admitKeyRequest(keyId, now = Date.now()) {
  if (!keyId) return () => {};
  const e = entry(keyId);
  prune(e, now);
  e.times.push(now);
  e.inFlight++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    e.inFlight = Math.max(0, e.inFlight - 1);
    clearTimeout(timer);
  };
  const timer = setTimeout(release, SLOT_TTL_MS);
  timer.unref?.();
  return release;
}

// Live usage snapshot for the dashboard (last minute / hour / day + in flight).
export function getKeyLimitUsage(keyId, now = Date.now()) {
  const e = state.get(keyId);
  if (!e) return { rpmUsed: 0, rphUsed: 0, rpdUsed: 0, inFlight: 0 };
  prune(e, now);
  return {
    rpmUsed: countWithin(e, now, MIN_MS),
    rphUsed: countWithin(e, now, HOUR_MS),
    rpdUsed: countWithin(e, now, DAY_MS),
    inFlight: e.inFlight,
  };
}

export function __resetKeyRateLimiter() {
  state.clear();
}
