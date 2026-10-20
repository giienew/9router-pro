// 9Router Pro — dashboard accent themes.
// Each accent only overrides the --color-brand-* scale (see globals.css);
// "coral" is the original upstream palette (no data-accent attribute).
export const ACCENTS = [
  { id: "coral", name: "Coral", swatch: "#E56A4A" },
  { id: "violet", name: "Violet", swatch: "#8B5CF6" },
  { id: "azure", name: "Azure", swatch: "#3B82F6" },
  { id: "emerald", name: "Emerald", swatch: "#10B981" },
  { id: "rose", name: "Rose", swatch: "#F43F5E" },
  { id: "amber", name: "Amber", swatch: "#F59E0B" },
  { id: "cyan", name: "Cyan", swatch: "#06B6D4" },
];

export const ACCENT_STORAGE_KEY = "9rp-accent";
export const DEFAULT_ACCENT = "coral";
// 9Router Pro signature: fresh installs open in violet (the Pro identity);
// picking Coral restores the exact original upstream palette.
export const PRO_DEFAULT_ACCENT = "violet";

export function isValidAccent(id) {
  return ACCENTS.some((a) => a.id === id);
}

export function applyAccent(id) {
  if (typeof document === "undefined") return;
  if (!id || id === DEFAULT_ACCENT || !isValidAccent(id)) {
    document.documentElement.removeAttribute("data-accent");
  } else {
    document.documentElement.setAttribute("data-accent", id);
  }
}
