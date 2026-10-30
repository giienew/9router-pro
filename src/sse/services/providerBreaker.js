// Provider breaker (P3-27): the provider-wide resilience layer.
//
// Layers, distinct timers, distinct scope:
//   * provider breaker (this file): whole provider, trips on broad failure,
//     OPEN for a minute, then a short probing window.
//   * connection cooldown: one account (modelLock + backoff in auth.js).
//   * model lockout: one model on one account (modelLock_<model>).
//
// State machine per provider: CLOSED → OPEN → HALF_OPEN → CLOSED.
//   CLOSED: failures counted in a sliding window. Trip when >=
//     MIN_FAILURES failures from >= MIN_CONNECTIONS distinct connections
//     inside WINDOW_MS. Auth failures never count (callers filter them).
//     Single-connection providers never trip: their one account's
//     cooldown (layer 2) already covers them; the breaker exists for
//     fleets, where per-account locks cannot express "the provider
//     itself is down".
//   OPEN: no traffic (selection skips the provider) until OPEN_MS passes.
//   HALF_OPEN: traffic flows for PROBE_MS; the FIRST failure re-opens
//     immediately, a success closes, and a quiet window expiry closes too
//     (no news is treated as recovered — the next failure re-trips fast
//     because fresh failures still count toward the threshold).
//
// Single-process assumption, like the sticky/rate-limit/proxy state: the
// live deploy is single-process, so this map is the breaker. Under
// multi-process deployments breakers diverge per process.
//
// Successes are recorded by the chat path only (handleSingleModelChat
// wrappers); modality handlers do not record them, so a breaker tripped
// by modality traffic closes via the probe-window expiry instead. That
// asymmetry is deliberate: closing needs a positive signal OR silence,
// never a guess.
import {
  PROVIDER_BREAKER_WINDOW_MS,
  PROVIDER_BREAKER_MIN_FAILURES,
  PROVIDER_BREAKER_MIN_CONNECTIONS,
  PROVIDER_BREAKER_OPEN_MS,
  PROVIDER_BREAKER_PROBE_MS,
} from "open-sse/config/errorConfig.js";

const states = new Map();

function entryFor(provider) {
  let e = states.get(provider);
  if (!e) {
    e = { state: "closed", failures: [], openedAt: null, halfOpenUntil: null };
    states.set(provider, e);
  }
  return e;
}

function prune(e, now) {
  const cutoff = now - PROVIDER_BREAKER_WINDOW_MS;
  e.failures = e.failures.filter((f) => f.at >= cutoff);
}

// Gate for selection: "allow" (closed, or half-open probing) or "skip"
// (open). Pure read — never mutates, so calling it per connection in a
// filter pass is safe.
export function providerBreakerGate(provider, now = Date.now()) {
  if (!provider) return "allow";
  const e = states.get(provider);
  if (!e || e.state === "closed") return "allow";
  if (e.state === "open") {
    if (now >= e.openedAt + PROVIDER_BREAKER_OPEN_MS) {
      e.state = "half-open";
      e.halfOpenUntil = now + PROVIDER_BREAKER_PROBE_MS;
      return "allow";
    }
    return "skip";
  }
  // half-open
  if (now >= e.halfOpenUntil) {
    e.state = "closed";
    e.failures = [];
    e.openedAt = null;
    e.halfOpenUntil = null;
    return "allow";
  }
  return "allow";
}

export function recordProviderFailure(provider, connectionId, now = Date.now()) {
  if (!provider || !connectionId) return;
  const e = entryFor(provider);
  if (e.state === "half-open") {
    // First failure in the probe window re-opens immediately.
    e.state = "open";
    e.openedAt = now;
    e.halfOpenUntil = null;
    e.failures = [];
    return;
  }
  if (e.state === "open") return;
  prune(e, now);
  e.failures.push({ at: now, connectionId });
  prune(e, now);
  const distinct = new Set(e.failures.map((f) => f.connectionId));
  if (
    e.failures.length >= PROVIDER_BREAKER_MIN_FAILURES &&
    distinct.size >= PROVIDER_BREAKER_MIN_CONNECTIONS
  ) {
    e.state = "open";
    e.openedAt = now;
    e.failures = [];
  }
}

export function recordProviderSuccess(provider, now = Date.now()) {
  if (!provider) return;
  const e = states.get(provider);
  if (!e) return;
  if (e.state === "half-open") {
    e.state = "closed";
    e.failures = [];
    e.openedAt = null;
    e.halfOpenUntil = null;
    return;
  }
  if (e.state === "closed") prune(e, now);
}

// Dashboard snapshot: never exposes connection ids, only counts + state.
export function getProviderBreakerSnapshot(now = Date.now()) {
  const out = {};
  for (const [provider, e] of states) {
    if (e.state === "closed") {
      prune(e, now);
      if (e.failures.length === 0) continue;
      out[provider] = { state: "closed", failuresInWindow: e.failures.length };
      continue;
    }
    out[provider] = {
      state: e.state === "open" ? "open" : "half-open",
      openedAt: e.openedAt ? new Date(e.openedAt).toISOString() : null,
      ...(e.state === "half-open" && e.halfOpenUntil
        ? { probeUntil: new Date(e.halfOpenUntil).toISOString() }
        : {}),
    };
  }
  return out;
}

// Test seam: reset all breaker state.
export function __resetProviderBreakers() {
  states.clear();
}
