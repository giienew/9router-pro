"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";

// R2 trust inbox bell: polls /api/notifications (30s), shows the unread
// count, and opens a small panel listing persistent events. Toasts stay
// transient; this bell is the durable record. Flat styling, shared tokens.
const LEVEL_STYLE = {
  critical: "text-red-600 dark:text-red-400",
  warn: "text-amber-600 dark:text-amber-400",
  info: "text-text-muted",
};

export default function TrustInboxBell() {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState([]);
  const [unread, setUnread] = useState(0);
  const ref = useRef(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications");
      if (!res.ok) return;
      const data = await res.json();
      setEvents(data.events || []);
      setUnread(data.unread || 0);
    } catch {}
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open ]);

  const markRead = async (id) => {
    await fetch("/api/notifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "read", id }) }).catch(() => {});
    load();
  };

  const markAll = async () => {
    await fetch("/api/notifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "read-all" }) }).catch(() => {});
    load();
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => { setOpen((v) => !v); if (!open) load(); }}
        className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-black/10 text-text-muted hover:text-text-main dark:border-white/10"
        aria-label="Notifications"
        title="Notifications"
      >
        <span className="material-symbols-outlined text-[20px]">notifications</span>
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 max-w-[90vw] rounded-lg border border-black/10 bg-surface p-2 dark:border-white/10">
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-sm font-semibold">Notifications</span>
            <button type="button" onClick={markAll} className="text-xs text-primary hover:underline">Mark all read</button>
          </div>
          {events.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-text-muted">No notifications yet.</p>
          ) : (
            <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
              {events.slice(0, 50).map((ev) => (
                <button
                  key={ev.id}
                  type="button"
                  onClick={() => markRead(ev.id)}
                  className={`rounded-md px-2 py-2 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.05] ${ev.read ? "opacity-60" : ""}`}
                >
                  <span className={`block text-xs font-medium ${LEVEL_STYLE[ev.level] || LEVEL_STYLE.info}`}>
                    {ev.level === "critical" ? "Critical" : ev.level === "warn" ? "Warning" : ev.kind} · {ev.createdAt ? new Date(ev.createdAt).toLocaleString() : ""}
                  </span>
                  <span className="block text-sm">{ev.title}</span>
                  {ev.detail && <span className="block text-xs text-text-muted">{ev.detail}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

TrustInboxBell.propTypes = {};
