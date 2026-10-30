"use client";

import { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import { GITHUB_CONFIG } from "@/shared/constants/config";

export default function ChangelogModal({ isOpen, onClose }) {
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const modalRef = useRef(null);

  useEffect(() => {
    if (!isOpen || html) return;
    setLoading(true);
    setError("");
    Promise.all([
      fetch(GITHUB_CONFIG.changelogUrl).then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      }),
      import("marked"),
    ])
      .then(([md, { marked }]) => {
        marked.setOptions({ gfm: true, breaks: true });
        setHtml(marked.parse(md));
      })
      .catch((err) => setError(err.message || "Failed to load"))
      .finally(() => setLoading(false));
  }, [isOpen, html]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (modalRef.current && !modalRef.current.contains(e.target)) {
        onClose();
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen, onClose]);

  if (!isOpen || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal content */}
      <div
        ref={modalRef}
        className="relative w-full bg-surface border border-black/10 dark:border-white/10 rounded-xl shadow-2xl animate-in fade-in zoom-in-95 duration-200 max-w-3xl flex flex-col max-h-[85vh]"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-3 border-b border-black/5 dark:border-white/5">
          <h2 className="text-lg font-semibold text-text-main">Change Log</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-text-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            aria-label="Close"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto flex-1">
          {/* Pro-only section (P3-30): what Pro adds over the base. Static
              and public-safe by construction — live-only patches on the
              operator's own instance are never listed here. */}
          <section className="mb-6 border-b border-black/10 pb-5 dark:border-white/10">
            <h3 className="text-base font-semibold text-text-main">What Pro adds over the base</h3>
            <div className="mt-3 flex flex-col gap-3 text-sm text-text-main">
              <div>
                <p className="font-medium">Routing</p>
                <ul className="list-disc pl-5 text-text-muted">
                  <li>Direct variant routing — a variant name routes to its model plus its prompt, with no backing combo.</li>
                  <li>Scored auto-routing — <code>auto:coding</code>, <code>auto:fast</code>, <code>auto:cheap</code>, <code>auto:headroom</code> pick from healthy providers by capability and headroom.</li>
                  <li>Per-combo strategies — fallback, round-robin, smart router, panel-plus-judge fusion, and capacity ordering, plus an account pin per member.</li>
                  <li>Combo member failover cap, and a total request deadline shared across retried members.</li>
                </ul>
              </div>
              <div>
                <p className="font-medium">Keys &amp; quotas</p>
                <ul className="list-disc pl-5 text-text-muted">
                  <li>Per-key policy — model allow-list, token and spend caps, and expiry, enforced on every endpoint, with a per-key usage view.</li>
                  <li>Quota and rate-limit admission at every handler entry, including the non-chat modalities.</li>
                </ul>
              </div>
              <div>
                <p className="font-medium">Resilience</p>
                <ul className="list-disc pl-5 text-text-muted">
                  <li>Three layers — provider breaker, connection cooldown, and model lockout — with distinct timers and dashboard states.</li>
                  <li>Auto-quarantine after repeated auth failures, and fail-open database handling so one bad row never kills a request.</li>
                </ul>
              </div>
              <div>
                <p className="font-medium">Dashboard</p>
                <ul className="list-disc pl-5 text-text-muted">
                  <li>Per-provider model lists are cached and resolved concurrently instead of one slow pass.</li>
                </ul>
              </div>
            </div>
          </section>
          {loading && (
            <div className="flex items-center justify-center py-10 text-text-muted">
              <span className="material-symbols-outlined animate-spin mr-2">progress_activity</span>
              Loading...
            </div>
          )}
          {error && (
            <div className="text-red-500 py-4">Failed to load changelog: {error}</div>
          )}
          {!loading && !error && html && (
            <div
              className="changelog-body text-text-main"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

ChangelogModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
};
