// Provider breaker (P3-27): the provider-wide resilience layer, plus
// per-model cooldowns (rival sweep 2026-11-12): one bad model must not park
// the whole provider.
//
// Layers, distinct timers, distinct scope:
//   * provider breaker (this file): whole provider, trips on broad failure,
//     OPEN for a minute, then a short probing window.
//   * per-model cooldown (this file): one model on a provider, trips when
//     that model's failures alone reach the threshold, with exponential
//     backoff (60s, 120s, 240s, ... capped at 10 min). A success for the
//     model clears its cooldown and resets the backoff.
//   * connection cooldown: one account (modelLock + backoff in auth.js).
//   * model lockout: one model on one account (modelLock_<model>).
//
// Why the model layer exists: a deterministically failing model (DeepAI's
// premium models failing 401 "Only paid accounts can use genius" on 22
// keys) used to trip the provider-wide breaker and park every model —
// including the five that worked — for over an hour. Now those failures
// park only the failing model.
//
// Which failures count toward the provider trip: a failure counts toward
// the provider bucket only when its model has no cooldown history
// (backoffLevel 0 and not cooling). Once a model has tripped its own
// cooldown, its failures are attributed to the model, never the provider
// — a known-bad model cannot trip the provider. A success for the model
// resets its history, so its future failures count toward the provider
// again. Unattributed failures (no model known) count toward the provider
// as before, so the provider trip still works when no model is known.
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
  PROVIDER_BREAKER_MODEL_COOLDOWN_MAX_MS,
} from "open-sse/config/errorConfig.js";

const states = new Map();

function entryFor(provider) {
  let e = states.get(provider);
  if (!e) {
    e = { state: "closed", failures: [], openedAt: null, halfOpenUntil: null, models: new Map() };
    states.set(provider, e);
  }
  return e;
}

function modelEntryFor(e, modelKey) {
  let m = e.models.get(modelKey);
  if (!m) {
    m = { failures: [], cooldownUntil: null, backoffLevel: 0 };
    e.models.set(modelKey, m);
  }
  return m;
}

// Model identity: the bare model id, so the failure path (auth.js, which
// may pass "provider/model") and the success path (chat.js /
// comboDispatch.js, which pass parseModel().model) key the same model.
function normalizeModelKey(provider, model) {
  if (typeof model !== "string" || model.length === 0) return null;
  const prefix = `${provider}/`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

function prune(e, now) {
  const cutoff = now - PROVIDER_BREAKER_WINDOW_MS;
  e.failures = e.failures.filter((f) => f.at >= cutoff);
}

function pruneModel(m, now) {
  const cutoff = now - PROVIDER_BREAKER_WINDOW_MS;
  m.failures = m.failures.filter((f) => f.at >= cutoff);
}

function modelCooldownMs(m) {
  return Math.min(
    PROVIDER_BREAKER_OPEN_MS * 2 ** m.backoffLevel,
    PROVIDER_BREAKER_MODEL_COOLDOWN_MAX_MS,
  );
}

// Gate for selection: "allow" (closed, or half-open probing) or "skip"
// (open). Pure read — never mutates, so calling it per connection in a
// filter pass is safe. A model in cooldown is skipped while the rest of
// the provider keeps serving.
//
// Backward-compatible overload: older callers passed a timestamp as the
// 2nd arg (provider, now). A numeric 2nd arg is a timestamp, never a
// model id (models are strings), so it is treated as `now`.
export function providerBreakerGate(provider, model = null, now = Date.now()) {
  if (typeof model === "number") {
    now = model;
    model = null;
  }
  if (!provider) return "allow";
  const e = states.get(provider);
  if (!e || e.state === "closed") {
    if (!e || !model) return "allow";
    const key = normalizeModelKey(provider, model);
    if (!key) return "allow";
    const m = e.models.get(key);
    if (!m || !m.cooldownUntil) return "allow";
    if (now >= m.cooldownUntil) {
      // Cooldown expired: the model is servable again. Keep backoffLevel —
      // a repeat failure escalates the next cooldown; only a success resets.
      m.cooldownUntil = null;
      m.failures = [];
      return "allow";
    }
    return "skip";
  }
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
  // Probing: do not burn the probe on a model already known-bad — the
  // probe must test a healthy model, or the provider re-opens on a
  // failure that was already priced in.
  if (model) {
    const key = normalizeModelKey(provider, model);
    if (key) {
      const m = e.models.get(key);
      if (m?.cooldownUntil && now < m.cooldownUntil) return "skip";
    }
  }
  return "allow";
}

export function recordProviderFailure(provider, connectionId, model = null, now = Date.now()) {
  // Backward-compatible overload: a numeric 3rd arg is a timestamp
  // (old callers passed (provider, connectionId, now)).
  if (typeof model === "number") {
    now = model;
    model = null;
  }
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
  const key = normalizeModelKey(provider, model);
  // A model already cooling down is ignored entirely — its failures must
  // not extend anything, mirroring the provider-open rule below.
  if (key) {
    const m = modelEntryFor(e, key);
    if (m.cooldownUntil && now < m.cooldownUntil) return;
    pruneModel(m, now);
    m.failures.push({ at: now, connectionId });
    pruneModel(m, now);
    const modelDistinct = new Set(m.failures.map((f) => f.connectionId));
    if (
      m.failures.length >= PROVIDER_BREAKER_MIN_FAILURES &&
      modelDistinct.size >= PROVIDER_BREAKER_MIN_CONNECTIONS
    ) {
      // This model alone reached the threshold: park the model with
      // exponential backoff, and drop its failures from the provider
      // bucket so they can never trip the provider.
      m.cooldownUntil = now + modelCooldownMs(m);
      m.backoffLevel += 1;
      m.failures = [];
      e.failures = e.failures.filter((f) => f.modelKey !== key);
      return;
    }
    // A model with cooldown history is known-bad: its failures belong to
    // the model, never the provider.
    if (m.backoffLevel > 0) return;
  }
  prune(e, now);
  e.failures.push({ at: now, connectionId, modelKey: key });
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

export function recordProviderSuccess(provider, model = null, now = Date.now()) {
  // Backward-compatible overload: a numeric 2nd arg is a timestamp
  // (old callers passed (provider, now)).
  if (typeof model === "number") {
    now = model;
    model = null;
  }
  if (!provider) return;
  const e = states.get(provider);
  if (!e) return;
  // A success for a model clears that model's cooldown and resets its
  // backoff — the model proved healthy again, so its future failures
  // count toward the provider once more. A success for a different model
  // never clears this one.
  if (model) {
    const key = normalizeModelKey(provider, model);
    if (key) {
      const m = e.models.get(key);
      if (m) {
        m.cooldownUntil = null;
        m.failures = [];
        m.backoffLevel = 0;
      }
    }
  }
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
// Model cooldowns are listed by model id (public catalog ids, safe).
export function getProviderBreakerSnapshot(now = Date.now()) {
  const out = {};
  for (const [provider, e] of states) {
    const modelCooldowns = {};
    for (const [modelKey, m] of e.models) {
      if (m.cooldownUntil && now < m.cooldownUntil) {
        modelCooldowns[modelKey] = {
          state: "cooldown",
          cooldownUntil: new Date(m.cooldownUntil).toISOString(),
          backoffLevel: m.backoffLevel,
        };
      }
    }
    if (e.state === "closed") {
      prune(e, now);
      if (e.failures.length === 0 && Object.keys(modelCooldowns).length === 0) continue;
      out[provider] = {
        state: "closed",
        failuresInWindow: e.failures.length,
        ...(Object.keys(modelCooldowns).length ? { models: modelCooldowns } : {}),
      };
      continue;
    }
    out[provider] = {
      state: e.state === "open" ? "open" : "half-open",
      openedAt: e.openedAt ? new Date(e.openedAt).toISOString() : null,
      ...(e.state === "half-open" && e.halfOpenUntil
        ? { probeUntil: new Date(e.halfOpenUntil).toISOString() }
        : {}),
      ...(Object.keys(modelCooldowns).length ? { models: modelCooldowns } : {}),
    };
  }
  return out;
}

// Test seam: reset all breaker state.
export function __resetProviderBreakers() {
  states.clear();
}
