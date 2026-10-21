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
  if (id === CUSTOM_ACCENT_ID) {
    const stored = getStoredCustomAccent();
    if (stored) {
      applyCustomAccent(stored);
      return;
    }
  }
  document.documentElement.style.removeProperty("--color-brand-base");
  if (!id || id === DEFAULT_ACCENT || !isValidAccent(id)) {
    document.documentElement.removeAttribute("data-accent");
  } else {
    document.documentElement.setAttribute("data-accent", id);
  }
}

// 9Router Pro: free-form custom accent. The whole brand scale is derived in
// CSS from a single base color (--color-brand-base, see globals.css), so any
// color the user picks with the slider/picker in the header menu just works.
export const CUSTOM_ACCENT_ID = "custom";
export const CUSTOM_ACCENT_KEY = "9rp-accent-custom";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
export function isValidHexColor(v) {
  return typeof v === "string" && HEX_RE.test(v);
}

export function getStoredCustomAccent() {
  if (typeof localStorage === "undefined") return null;
  try {
    const v = localStorage.getItem(CUSTOM_ACCENT_KEY);
    return isValidHexColor(v) ? v : null;
  } catch {
    return null;
  }
}

export function applyCustomAccent(hex) {
  if (typeof document === "undefined" || !isValidHexColor(hex)) return;
  const el = document.documentElement;
  el.setAttribute("data-accent", CUSTOM_ACCENT_ID);
  el.style.setProperty("--color-brand-base", hex);
  try {
    localStorage.setItem(ACCENT_STORAGE_KEY, CUSTOM_ACCENT_ID);
    localStorage.setItem(CUSTOM_ACCENT_KEY, hex);
  } catch { /* private mode */ }
}

export function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x) => Math.round(255 * x).toString(16).padStart(2, "0");
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}

export function hexToHue(hex) {
  if (!isValidHexColor(hex)) return 262;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx === mn) return 262;
  const d = mx - mn;
  let h;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return Math.round(h < 0 ? h + 360 : h);
}
