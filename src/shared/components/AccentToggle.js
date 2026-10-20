"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/shared/utils/cn";
import { ACCENTS, ACCENT_STORAGE_KEY, DEFAULT_ACCENT, applyAccent, isValidAccent } from "@/shared/constants/accents";

// 9Router Pro — accent picker. A palette button in the header opens a small
// swatch popover; the choice persists in localStorage and is applied before
// first paint by the inline script in app/layout.js.
export default function AccentToggle({ className }) {
  const [open, setOpen] = useState(false);
  const [accent, setAccent] = useState(DEFAULT_ACCENT);
  const rootRef = useRef(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(ACCENT_STORAGE_KEY);
      if (saved && isValidAccent(saved)) setAccent(saved);
    } catch { /* private mode */ }
  }, []);

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
