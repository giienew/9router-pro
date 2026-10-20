// 9Router Pro — the Soul Prompts icon is user-changeable from the Soul
// Prompts page. Stored per browser (like the accent/preset choices) and
// broadcast with a window event so the sidebar updates instantly.
export const SOUL_ICONS = [
  "psychology",
  "neurology",
  "auto_awesome",
  "self_improvement",
  "emoji_objects",
  "flare",
  "skull",
  "bolt",
];

export const SOUL_ICON_KEY = "9rp-soul-icon";
export const SOUL_ICON_EVENT = "soul-icon-change";
export const DEFAULT_SOUL_ICON = "psychology";

export function getSoulIcon() {
  if (typeof localStorage === "undefined") return DEFAULT_SOUL_ICON;
  try {
    const v = localStorage.getItem(SOUL_ICON_KEY);
    return SOUL_ICONS.includes(v) ? v : DEFAULT_SOUL_ICON;
  } catch {
    return DEFAULT_SOUL_ICON;
  }
}

export function setSoulIcon(icon) {
  if (!SOUL_ICONS.includes(icon)) return;
  try {
    localStorage.setItem(SOUL_ICON_KEY, icon);
  } catch { /* private mode */ }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(SOUL_ICON_EVENT));
  }
}
