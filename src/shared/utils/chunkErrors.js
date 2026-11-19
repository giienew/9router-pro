// Stale-chunk self-heal: after a deploy, a chunk URL from the previous
// build 404s and the page would otherwise stay broken. Detecting the
// chunk-load failure and reloading once fetches the fresh build instead.
//
// The reload is guarded by a timestamp in sessionStorage so a page that
// fails again immediately does not loop forever; a stale chunk from a
// LATER deploy (minutes later) can still heal.

const CHUNK_ERROR_RE = /ChunkLoadError|Loading chunk \d+ failed|Failed to fetch dynamically imported module|Importing a module script failed/i;

export const CHUNK_RELOAD_FLAG_KEY = "9rp-chunk-reloaded";
export const CHUNK_RELOAD_GUARD_MS = 60_000;

export function isChunkLoadError(value) {
  if (!value) return false;
  const message = typeof value === "string" ? value : value.message || "";
  return CHUNK_ERROR_RE.test(message);
}

// Returns true when a reload should happen now, and records the reload
// timestamp so an immediate repeat failure does not loop. `storage` is
// injectable for tests; defaults to sessionStorage when available.
export function shouldHealChunkError(storage) {
  try {
    const store = storage || (typeof sessionStorage !== "undefined" ? sessionStorage : null);
    if (!store) return true;
    const last = Number(store.getItem(CHUNK_RELOAD_FLAG_KEY) || 0);
    if (Date.now() - last < CHUNK_RELOAD_GUARD_MS) return false;
    store.setItem(CHUNK_RELOAD_FLAG_KEY, String(Date.now()));
    return true;
  } catch {
    return true;
  }
}
