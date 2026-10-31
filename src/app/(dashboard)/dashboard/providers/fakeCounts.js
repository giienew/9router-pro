// Display override: fake connection counts for screenshots.
// Stored in this browser only (localStorage). Never sent to the server and
// never changes real counts, routing, health, or any API response. Removing
// the key (or Reset in the menu) restores the original counts.
const STORAGE_KEY = "9router-fake-connection-counts";

export function loadFakeCounts() {
  try {
    if (typeof window === "undefined") return {};
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (Number.isInteger(value) && value >= 0) out[id] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function persistFakeCounts(map) {
  try {
    if (typeof window === "undefined") return;
    const clean = {};
    for (const [id, value] of Object.entries(map)) {
      if (Number.isInteger(value) && value >= 0) clean[id] = value;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // Private-mode storage may throw; the override just won't persist.
  }
}
