"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/shared/utils/cn";
import { registerTopmostModal, isTopmostModal } from "./Modal";

export default function Drawer({
  isOpen,
  onClose,
  title,
  children,
  width = "md",
  className
}) {
  const widths = {
    sm: "w-[400px]",
    md: "w-[500px]",
    lg: "w-[600px]",
    xl: "w-[800px]",
    full: "w-full",
  };

  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [isOpen]);

  // Same topmost rule as Modal: Escape closes this drawer only when no
  // modal is open above it.
  useEffect(() => {
    if (!isOpen) return;
    const entry = { close: () => onCloseRef.current?.() };
    const unregister = registerTopmostModal(entry);
    const handleEscape = (e) => {
      if (e.key === "Escape" && isTopmostModal(entry)) entry.close();
    };
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("keydown", handleEscape);
      unregister();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  // Render at <body> level (same reason as Modal): callers live inside
  // containers whose backdrop-blur / transform traps position:fixed.
  return createPortal(
    <div className="fixed inset-0 z-50">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-[2px] fade-in cursor-pointer"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer panel */}
      <div className={cn(
        "absolute right-0 top-0 h-full bg-surface flex flex-col",
        "shadow-[var(--shadow-elev)]",
        "slide-in-right",
        "border-l border-border-subtle",
        "max-w-[100vw]",
        widths[width] || widths.md,
        className
      )}>
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border-subtle flex-shrink-0">
          <div className="flex items-center gap-3">
            {title && (
              <h2 className="text-lg font-semibold text-text-main">{title}</h2>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-[10px] text-text-muted hover:bg-surface-2 hover:text-text-main transition-colors"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
}
