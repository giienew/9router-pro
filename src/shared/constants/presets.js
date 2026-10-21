// 9Router Pro — UI theme presets.
// "dark-pro" is the Pro signature look: a flat, modern pitch-black
// palette (tonal surface steps + hairline borders, no embossing). "ori" restores the
// exact original upstream palette and light/dark behavior.
// The preset lives on <html data-preset="dark-pro">; colors are CSS variable
// overrides in globals.css. Absence of a stored choice means Dark Pro.
export const PRESETS = [
  { id: "ori", name: "Ori", hint: "Original 9Router look" },
  { id: "dark-pro", name: "Dark Pro", hint: "Pitch black · Flat modern" },
];

export const PRESET_STORAGE_KEY = "9rp-preset";
export const DEFAULT_PRESET = "dark-pro";

export function isValidPreset(id) {
  return PRESETS.some((p) => p.id === id);
}

export function getStoredPreset() {
  if (typeof localStorage === "undefined") return DEFAULT_PRESET;
  try {
    const saved = localStorage.getItem(PRESET_STORAGE_KEY);
    return isValidPreset(saved) ? saved : DEFAULT_PRESET;
  } catch {
    return DEFAULT_PRESET;
  }
}

export function isDarkProActive() {
  return getStoredPreset() === "dark-pro";
}

export function applyPreset(id) {
  if (typeof document === "undefined") return;
  if (id === "dark-pro") {
    document.documentElement.setAttribute("data-preset", "dark-pro");
  } else {
    document.documentElement.removeAttribute("data-preset");
  }
  try {
    localStorage.setItem(PRESET_STORAGE_KEY, id);
  } catch { /* private mode */ }
}
