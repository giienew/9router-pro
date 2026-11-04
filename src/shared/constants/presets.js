// 9Router Pro — single default theme.
// The Ori and Dark Pro presets were removed (owner order 2026-11-02): the
// dashboard now has exactly one look — dark neumorphism, premium floating
// surfaces. The module stays so old imports keep working: every stored
// preset choice migrates to the default, and the legacy localStorage key is
// cleared on read.
export const PRESETS = [
  { id: "neu", name: "Neumorphism", hint: "Dark · Premium floating" },
];

export const PRESET_STORAGE_KEY = "9rp-preset";
export const DEFAULT_PRESET = "neu";

export function isValidPreset(id) {
  return id === DEFAULT_PRESET;
}

export function getStoredPreset() {
  if (typeof localStorage !== "undefined") {
    try {
      // One-time migration: drop the retired ori/dark-pro choice.
      const saved = localStorage.getItem(PRESET_STORAGE_KEY);
      if (saved && saved !== DEFAULT_PRESET) {
        localStorage.removeItem(PRESET_STORAGE_KEY);
      }
    } catch { /* private mode */ }
  }
  return DEFAULT_PRESET;
}

export function applyPreset() {
  // Single theme: nothing to switch. Clear any legacy stored choice.
  if (typeof document === "undefined") return;
  document.documentElement.removeAttribute("data-preset");
  try {
    localStorage.removeItem(PRESET_STORAGE_KEY);
  } catch { /* private mode */ }
}
