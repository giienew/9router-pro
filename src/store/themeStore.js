"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { THEME_CONFIG } from "@/shared/constants/config";

// 9Router Pro is dark-only since the neumorphism restyle (owner order
// 2026-11-02): one default theme, no light/dark toggle, no presets.
// The store API stays (theme/setTheme/toggleTheme/initTheme) so existing
// callers keep working — every path lands on dark.
const useThemeStore = create(
  persist(
    (set) => ({
      theme: "dark",

      setTheme: () => {
        set({ theme: "dark" });
        applyTheme();
      },

      toggleTheme: () => {
        set({ theme: "dark" });
        applyTheme();
      },

      initTheme: () => {
        applyTheme();
      },
    }),
    {
      name: THEME_CONFIG.storageKey,
    }
  )
);

// Dark, always.
function applyTheme() {
  if (typeof window === "undefined") return;
  document.documentElement.classList.add("dark");
}

export default useThemeStore;
