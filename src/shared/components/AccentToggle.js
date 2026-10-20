"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/shared/utils/cn";
import { ACCENTS, ACCENT_STORAGE_KEY, PRO_DEFAULT_ACCENT, applyAccent, isValidAccent } from "@/shared/constants/accents";
import { PRESETS, getStoredPreset, applyPreset } from "@/shared/constants/presets";
import useThemeStore from "@/store/themeStore";

// 9Router Pro — theme + accent picker. A palette button in the header opens
// a small popover: theme presets (Ori / Dark Pro) and accent swatches. Both
// persist in localStorage and are applied before first paint by the inline
// scripts in app/layout.js.
export default function AccentToggle({ className }) {
  const [open, setOpen] = useState(false);
  const [accent, setAccent] = useState(PRO_DEFAULT_ACCENT);
  const [preset, setPreset] = useState("dark-pro");
  const rootRef = useRef(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(ACCENT_STORAGE_KEY);
      if (saved && isValidAccent(saved)) setAccent(saved);
    } catch { /* private mode */ }
    setPreset(getStoredPreset());
  }, []);

  const choosePreset = (id) => {
    setPreset(id);
    applyPreset(id);
    if (id === "dark-pro") {
      // Dark Pro is always dark — align the theme store so nothing fights it.
      useThemeStore.getState().setTheme("dark");
    }
  };

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open ]);

  const choose = (id) => {
    setAccent(id);
    applyAccent(id);
    try {
      localStorage.setItem(ACCENT_STORAGE_KEY, id);
    } catch { /* private mode */ }
    setOpen(false);
  };

  const active = ACCENTS.find((a) => a.id === accent) || ACCENTS[0];

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-center size-10 rounded-full text-text-muted hover:text-text-main hover:bg-surface-2 transition-colors cursor-pointer"
        aria-label="Dashboard accent color"
        title={`Accent: ${active.name}`}
      >
        <span className="material-symbols-outlined text-[22px]">palette</span>
        <span
          className="absolute bottom-1.5 right-1.5 size-2.5 rounded-full border-2 border-surface"
          style={{ backgroundColor: active.swatch }}
        />
      </button>

      {open && (
        <div className="absolute right-0 top-12 z-50 w-60 rounded-[14px] bg-surface border border-border-subtle shadow-[var(--shadow-elev)] p-3 fade-in">
          <p className="text-xs font-medium text-text-muted uppercase tracking-wide px-1 pb-2">
            Theme
          </p>
          <div className="flex flex-col gap-1 pb-1">
            {PRESETS.map((p) => {
              const isActive = p.id === preset;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => choosePreset(p.id)}
                  className={cn(
                    "flex items-center gap-2 px-2 py-1.5 rounded-[8px] text-sm transition-colors cursor-pointer text-left",
                    isActive ? "bg-surface-2 text-text-main font-medium" : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                  )}
                >
                  <span
                    className={cn("size-4 rounded-full shrink-0 border border-white/20", isActive && "ring-2 ring-offset-2 ring-offset-surface ring-current")}
                    style={p.id === "dark-pro"
                      ? { backgroundColor: "#000000", color: "#8B5CF6" }
                      : { background: "linear-gradient(135deg, #f5f0ea 50%, #262626 50%)", color: "#E56A4A" }}
                  />
                  <span className="flex flex-col">
                    <span>{p.name}</span>
                    <span className="text-[11px] text-text-muted/80 font-normal">{p.hint}</span>
                  </span>
                  {isActive && (
                    <span className="material-symbols-outlined text-[16px] ml-auto text-brand-500">check</span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="border-t border-border-subtle my-2" />
          <p className="text-xs font-medium text-text-muted uppercase tracking-wide px-1 pb-2">
            Accent color
          </p>
          <div className="grid grid-cols-2 gap-1">
            {ACCENTS.map((a) => {
              const isActive = a.id === accent;
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => choose(a.id)}
                  className={cn(
                    "flex items-center gap-2 px-2 py-1.5 rounded-[8px] text-sm transition-colors cursor-pointer",
                    isActive ? "bg-surface-2 text-text-main font-medium" : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                  )}
                >
                  <span
                    className={cn("size-4 rounded-full shrink-0", isActive && "ring-2 ring-offset-2 ring-offset-surface ring-current")}
                    style={{ backgroundColor: a.swatch, color: a.swatch }}
                  />
                  {a.name}
                  {isActive && (
                    <span className="material-symbols-outlined text-[16px] ml-auto text-brand-500">check</span>
                  )}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-text-muted/70 px-1 pt-2">
            Applies instantly, saved in this browser.
          </p>
        </div>
      )}
    </div>
  );
}
