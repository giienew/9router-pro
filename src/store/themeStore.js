"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { THEME_CONFIG } from "@/shared/constants/config";
import { isDarkProActive, applyPreset } from "@/shared/constants/presets";

const useThemeStore = create(
  persist(
    (set, get) => ({
      theme: THEME_CONFIG.defaultTheme,

      setTheme: (theme) => {
        // 9Router Pro: an explicit light choice exits the Dark Pro preset.
        if (theme === "light" && isDarkProActive()) applyPreset("ori");
        set({ theme });
        applyTheme(theme);
      },

      toggleTheme: () => {
        // 9Router Pro: toggling while Dark Pro is active leaves the preset
        // and lands on Ori light (the sun-icon affordance).
        if (isDarkProActive()) {
          applyPreset("ori");
          set({ theme: "light" });
          applyTheme("light");
          return;
        }
        const currentTheme = get().theme;
        const newTheme = currentTheme === "dark" ? "light" : "dark";
        set({ theme: newTheme });
        applyTheme(newTheme);
      },

      initTheme: () => {
        const theme = get().theme;
        applyTheme(theme);
      },
    }),
    {
      name: THEME_CONFIG.storageKey,
    }
  )
);

// Apply theme to document
function applyTheme(theme) {
  if (typeof window === "undefined") return;

  const root = document.documentElement;
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";

  const effectiveTheme = theme === "system" ? systemTheme : theme;

  // 9Router Pro: the Dark Pro preset is always dark.
  if (effectiveTheme === "dark" || isDarkProActive()) {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
}

export default useThemeStore;

