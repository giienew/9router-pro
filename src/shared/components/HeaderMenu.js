"use client";

import { useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import { useTheme } from "@/shared/hooks/useTheme";
import ChangelogModal from "./ChangelogModal";
import { ConfirmModal } from "./Modal";
import { cn } from "@/shared/utils/cn";
import { ACCENT_STORAGE_KEY, PRO_DEFAULT_ACCENT, isValidAccent, applyCustomAccent, getStoredCustomAccent, hslToHex, hexToHue, CUSTOM_ACCENT_ID } from "@/shared/constants/accents";
import { PRESETS, getStoredPreset, applyPreset } from "@/shared/constants/presets";
import useThemeStore from "@/store/themeStore";

function MenuItem({ icon, label, onClick, trailing, danger }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-3 w-full px-4 py-2.5 text-sm transition-colors ${
        danger
          ? "text-red-500 hover:bg-red-500/10"
          : "text-text-main hover:bg-black/5 dark:hover:bg-white/5"
      }`}
    >
      <span className={`material-symbols-outlined text-[20px] ${danger ? "" : "text-text-muted"}`}>
        {icon}
      </span>
      <span className="flex-1 text-left">{label}</span>
      {trailing}
    </button>
  );
}

MenuItem.propTypes = {
  icon: PropTypes.string.isRequired,
  label: PropTypes.string.isRequired,
  onClick: PropTypes.func.isRequired,
  trailing: PropTypes.node,
  danger: PropTypes.bool,
};

export default function HeaderMenu({ onLogout }) {
  const [isOpen, setIsOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [shutdownOpen, setShutdownOpen] = useState(false);
  const [isShuttingDown, setIsShuttingDown] = useState(false);
  const { toggleTheme, isDark } = useTheme();
  const menuRef = useRef(null);

  // 9Router Pro: appearance (theme preset + accent) lives in this menu now —
  // it used to be a palette popover in the header bar. Same localStorage keys,
  // so the pre-paint scripts in app/layout.js keep working unchanged.
  const [accent, setAccent] = useState(PRO_DEFAULT_ACCENT);
  const [preset, setPreset] = useState("dark-pro");
  const [customHex, setCustomHex] = useState("#8B5CF6");
  const [hue, setHue] = useState(262);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(ACCENT_STORAGE_KEY);
      if (saved === CUSTOM_ACCENT_ID) {
        const c = getStoredCustomAccent();
        if (c) {
          setAccent(CUSTOM_ACCENT_ID);
          setCustomHex(c);
          setHue(hexToHue(c));
        }
      } else if (saved && isValidAccent(saved)) {
        setAccent(saved);
      }
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

  // Free color choice: slide the hue (or tap the dot for an exact color) and
  // the whole brand scale is derived from it live — see constants/accents.js.
  const onHue = (e) => {
    const h = Number(e.target.value);
    const hex = hslToHex(h, 84, 58);
    setHue(h);
    setCustomHex(hex);
    setAccent(CUSTOM_ACCENT_ID);
    applyCustomAccent(hex);
  };

  const onPickColor = (e) => {
    const hex = e.target.value;
    setCustomHex(hex);
    setHue(hexToHue(hex));
    setAccent(CUSTOM_ACCENT_ID);
    applyCustomAccent(hex);
  };

  const handleShutdown = async () => {
    setIsShuttingDown(true);
    try {
      await fetch("/api/version/shutdown", { method: "POST" });
    } catch (e) {
      // Expected to fail as server shuts down; ignore error
    }
    setIsShuttingDown(false);
    setShutdownOpen(false);
  };

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  const close = () => setIsOpen(false);

  return (
    <>
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setIsOpen((v) => !v)}
          className="flex items-center justify-center p-2 rounded-lg text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/5 transition-all"
          title="Menu"
        >
          <span className="material-symbols-outlined">grid_view</span>
        </button>

        {isOpen && (
          <div className="absolute right-0 top-full mt-2 w-64 max-h-[80vh] overflow-y-auto bg-surface border border-black/10 dark:border-white/10 rounded-xl shadow-2xl z-50 animate-in fade-in zoom-in-95 duration-150 py-1">
            <MenuItem
              icon="history"
              label="Change Log"
              onClick={() => { close(); setChangelogOpen(true); }}
            />
            <MenuItem
              icon={isDark ? "light_mode" : "dark_mode"}
              label="Theme"
              trailing={<span className="text-xs text-text-muted">{isDark ? "Dark" : "Light"}</span>}
              onClick={toggleTheme}
            />

            <div className="my-1 border-t border-black/5 dark:border-white/5" />
            <p className="px-4 pt-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
              Appearance
            </p>
            <div className="flex flex-col gap-0.5 px-2">
              {PRESETS.map((p) => {
                const isActive = p.id === preset;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => choosePreset(p.id)}
                    className={cn(
                      "flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm transition-colors cursor-pointer text-left",
                      isActive ? "bg-black/5 dark:bg-white/5 text-text-main font-medium" : "text-text-muted hover:bg-black/5 dark:hover:bg-white/5 hover:text-text-main"
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
            <p className="px-4 pt-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
              Custom color
            </p>
            <div className="flex items-center gap-2.5 px-4 pb-2">
              <input
                type="range"
                min="0"
                max="359"
                value={hue}
                onChange={onHue}
                className="hue-slider min-w-0 flex-1 cursor-pointer"
                style={{ background: "linear-gradient(90deg,#ff0000,#ffff00,#00ff00,#00ffff,#0000ff,#ff00ff,#ff0000)" }}
                aria-label="Custom accent color hue"
              />
              <label
                className="relative size-6 shrink-0 cursor-pointer rounded-full border border-white/25"
                style={{ backgroundColor: customHex }}
                title="Pick an exact color"
              >
                <input type="color" value={customHex} onChange={onPickColor} className="absolute inset-0 cursor-pointer opacity-0" />
              </label>
              <span className="w-14 shrink-0 font-mono text-[11px] uppercase text-text-muted">
                {accent === CUSTOM_ACCENT_ID ? customHex : "—"}
              </span>
            </div>

            <div className="my-1 border-t border-black/5 dark:border-white/5" />
            <MenuItem
              icon="power_settings_new"
              label="Shutdown"
              danger
              onClick={() => { close(); setShutdownOpen(true); }}
            />
            <MenuItem
              icon="logout"
              label="Logout"
              danger
              onClick={() => { close(); onLogout(); }}
            />
          </div>
        )}
      </div>

      <ChangelogModal isOpen={changelogOpen} onClose={() => setChangelogOpen(false)} />
      <ConfirmModal
        isOpen={shutdownOpen}
        onClose={() => setShutdownOpen(false)}
        onConfirm={handleShutdown}
        title="Close Proxy"
        message="Are you sure you want to close the proxy server?"
        confirmText="Close"
        cancelText="Cancel"
        variant="danger"
        loading={isShuttingDown}
      />
    </>
  );
}

HeaderMenu.propTypes = {
  onLogout: PropTypes.func.isRequired,
};
