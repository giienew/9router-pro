// Least-busy routing (9Router Pro): prefer the least-loaded eligible
// connection among a provider's keys, so agent clients hammering a
// multi-key provider (dahl) spread across farmed keys instead of piling
// onto one. LiteLLM-style idea, Pro-shaped: the load signal is cheap and
// bounded — in-flight picks counted in memory at selection time, plus
// recent failures in a short window. No timer, no polling loop, no new
// dependency, no extra DB read: the picker's caller (auth.js) notes every
// pick synchronously and reports every outcome (success via
// clearAccountError, failure via markAccountUnavailable), so the counts
// track real load including long streaming replies. Single-process
// assumption, same as the sticky and overlay state next to it: under
// multi-process, load diverges per process.
//
// Stale safety: an outcome that never reports (aborted stream, flaky
// retry that re-picks without clearing, Antigravity quota path that skips
// markAccountUnavailable) leaves a phantom in-flight entry — it ages out
// lazily on the next read after LEAST_BUSY_IN_FLIGHT_STALE_MS instead of
// wedging a key forever. Memory is capped at LEAST_BUSY_MAX_ENTRIES
// entries (dahl's fleet is ~2.4k keys), with per-key caps on stored
// timestamps, and idle entries are dropped outright.

import {
  LEAST_BUSY_IN_FLIGHT_WEIGHT,
  LEAST_BUSY_RECENT_ERROR_WEIGHT,
  LEAST_BUSY_RECENT_ERROR_WINDOW_MS,
  LEAST_BUSY_IN_FLIGHT_STALE_MS,
  LEAST_BUSY_MAX_ENTRIES,
  LEAST_BUSY_MAX_ERRORS_PER_KEY,
  LEAST_BUSY_MAX_IN_FLIGHT_PER_KEY,
} from "../config/errorConfig.js";
import { lruKeyForConnection } from "./accountFallback.js";

// connectionId -> { pickedAt: number[], errors: number[], touchedAt: number }
// pickedAt holds one timestamp per outstanding pick; errors holds one
// timestamp per reported failure inside the recent-error window.
export const leastBusyLoad = new Map();

function pruneEntry(entry, now) {
  const inFlightCutoff = now - LEAST_BUSY_IN_FLIGHT_STALE_MS;
  while (entry.pickedAt.length && entry.pickedAt[0] <= inFlightCutoff) entry.pickedAt.shift();
  const errorCutoff = now - LEAST_BUSY_RECENT_ERROR_WINDOW_MS;
  while (entry.errors.length && entry.errors[0] <= errorCutoff) entry.errors.shift();
  return entry;
}

function evictOldestIdle(newId) {
  let victim = null;
  let victimTouchedAt = Infinity;
  let fallback = null;
  let fallbackTouchedAt = Infinity;
  for (const [id, entry] of leastBusyLoad) {
    if (id === newId) continue;
    if (entry.pickedAt.length === 0 && entry.touchedAt < victimTouchedAt) {
      victim = id;
      victimTouchedAt = entry.touchedAt;
    }
    if (entry.touchedAt < fallbackTouchedAt) {
      fallback = id;
      fallbackTouchedAt = entry.touchedAt;
    }
  }
  const evict = victim ?? fallback;
  if (evict) leastBusyLoad.delete(evict);
}

function entryFor(id, now, create) {
  let entry = leastBusyLoad.get(id);
  if (!entry && !create) return null;
  if (!entry) {
    if (leastBusyLoad.size >= LEAST_BUSY_MAX_ENTRIES) evictOldestIdle(id);
    entry = { pickedAt: [], errors: [], touchedAt: now };
    leastBusyLoad.set(id, entry);
  }
  pruneEntry(entry, now);
  entry.touchedAt = now;
  return entry;
}

/**
 * Note that a connection was picked. Called for every pick in
 * getProviderCredentials, whatever the strategy — the tracker only
 * steers least-busy picks, but its in-flight counts must reflect real
 * load, not just least-busy traffic.
 */
export function noteLeastBusyPick(id, now = Date.now()) {
  if (!id) return;
  const entry = entryFor(id, now, true);
  if (entry.pickedAt.length >= LEAST_BUSY_MAX_IN_FLIGHT_PER_KEY) entry.pickedAt.shift();
  entry.pickedAt.push(now);
}

/**
 * Note that a picked connection's outcome reported. `ok` true on success
 * (clearAccountError), false on failure (markAccountUnavailable). Removes
 * one outstanding pick; a failure also records a recent-error timestamp
 * even when no pick was outstanding, because a reported failure is real
 * load signal regardless of how the pick was counted.
 */
export function noteLeastBusyRelease(id, ok, now = Date.now()) {
  if (!id) return;
  const entry = entryFor(id, now, !ok);
  if (!entry) return;
  if (entry.pickedAt.length) entry.pickedAt.shift();
  if (ok === false) {
    if (entry.errors.length >= LEAST_BUSY_MAX_ERRORS_PER_KEY) entry.errors.shift();
    entry.errors.push(now);
  }
  // An idle entry with no recent errors carries no signal — drop it so
  // the map only holds keys that are busy or recently failed.
  if (!entry.pickedAt.length && !entry.errors.length) leastBusyLoad.delete(id);
}

/**
 * Live load snapshot for one connection (pruned to the current windows).
 * Unknown ids are idle with no recent errors.
 */
export function getLeastBusySnapshot(id, now = Date.now(), load = leastBusyLoad) {
  if (!id) return { inFlight: 0, recentErrors: 0 };
  const entry = load.get(id);
  if (!entry) return { inFlight: 0, recentErrors: 0 };
  pruneEntry(entry, now);
  return { inFlight: entry.pickedAt.length, recentErrors: entry.errors.length };
}

/**
 * Load score for one connection: each in-flight request costs more than
 * each recent failure, so a busy-but-healthy key loses to an idle one
 * while a key that just failed repeatedly still loses to a key carrying
 * a single live request. Lower is less busy.
 */
export function leastBusyScore(connection, now = Date.now(), load = leastBusyLoad) {
  if (!connection) return Infinity;
  const { inFlight, recentErrors } = getLeastBusySnapshot(connection.id, now, load);
  return (
    inFlight * LEAST_BUSY_IN_FLIGHT_WEIGHT +
    recentErrors * LEAST_BUSY_RECENT_ERROR_WEIGHT
  );
}

/**
 * Pick the least-busy connection from an already-eligible tier (the
 * caller filters health tiers first, same as balanced). Ties break by
 * least-recently-used (same ordering as the balanced window), then by a
 * random draw among exact ties so a burst of identical keys still
 * spreads. Pure selection — it never mutates load state; the caller
 * notes the pick. Single O(n) pass, one timestamp parse per connection
 * at most, so a 2.4k-key fleet costs microseconds, not a sort.
 * @param {Array} connections - Eligible connections
 * @param {number} now - Current time in ms
 * @param {function} rng - Random source returning [0, 1)
 * @param {Map} load - Load tracker (defaults to the shared map)
 * @param {Map|null} overlay - Optional in-memory last-used overrides
 * @returns {object|null}
 */
export function pickLeastBusy(connections, now = Date.now(), rng = Math.random, load = leastBusyLoad, overlay = null) {
  if (!connections?.length) return null;
  let bestScore = Infinity;
  let bestLruKey = Infinity;
  let tied = [];
  for (const connection of connections) {
    const score = leastBusyScore(connection, now, load);
    if (score > bestScore) continue;
    const lruKey = lruKeyForConnection(connection, overlay);
    if (score < bestScore || lruKey < bestLruKey) {
      bestScore = score;
      bestLruKey = lruKey;
      tied = [connection];
    } else if (lruKey === bestLruKey) {
      tied.push(connection);
    }
  }
  return tied[Math.floor(rng() * tied.length)];
}

export function resetLeastBusyLoad() {
  leastBusyLoad.clear();
}
