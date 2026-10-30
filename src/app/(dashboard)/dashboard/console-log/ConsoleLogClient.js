"use client";

import { useState, useEffect, useRef } from "react";
import { Card, Button } from "@/shared/components";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config";
import { parseConsoleLine } from "@/lib/logLineParse";

// MatLog-style rows (9Router Pro): every line renders as time + level
// badge + short tag + one plain message, so the panel scans like a
// logcat viewer instead of a wall of green terminal text. The badges
// copy MatLog's own colors and shape: a solid bright square with a
// bold black letter (I green, W yellow, E red, D blue, neutral gray).
const LEVEL_BADGES = {
  E: "bg-[#f44336] text-black",
  W: "bg-[#ffeb3b] text-black",
  I: "bg-[#4caf50] text-black",
  D: "bg-[#2196f3] text-black",
  "✓": "bg-[#4caf50] text-black",
  "·": "bg-[#9e9e9e] text-black",
};

function LogRow({ line }) {
  const p = parseConsoleLine(line);
  const badge = LEVEL_BADGES[p.level] || LEVEL_BADGES["·"];
  return (
    <div className="flex items-start gap-2 border-b border-white/5 py-[3px] last:border-0">
      <span className="w-[52px] shrink-0 pt-[2px] text-zinc-500">{p.time || "—"}</span>
      <span className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[3px] text-[10px] font-extrabold ${badge}`}>
        {p.level}
      </span>
      <span className="flex w-[68px] shrink-0 items-center gap-1 pt-[2px]">
        {p.dot ? (
          <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ backgroundColor: p.dot }} />
        ) : null}
        <span className="truncate text-[10px] font-semibold tracking-wide text-zinc-400">{p.tag}</span>
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-zinc-200">{p.message}</span>
    </div>
  );
}

export default function ConsoleLogClient() {
  const [logs, setLogs] = useState([]);
  const [connected, setConnected] = useState(false);
  const [retries, setRetries] = useState(0);
  const [connectKey, setConnectKey] = useState(0);
  const logRef = useRef(null);

  const handleClear = async () => {
    try {
      await fetch("/api/translator/console-logs", { method: "DELETE" });
      // UI cleared via SSE "clear" event
    } catch (err) {
      console.error("Failed to clear console logs:", err);
    }
  };

  useEffect(() => {
    const es = new EventSource("/api/translator/console-logs/stream");

    es.onopen = () => {
      setConnected(true);
      setRetries(0);
    };

    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "init") {
        setLogs(msg.logs.slice(-CONSOLE_LOG_CONFIG.maxLines));
      } else if (msg.type === "line") {
        setLogs((prev) => {
          const next = [...prev, msg.line];
          return next.length > CONSOLE_LOG_CONFIG.maxLines ? next.slice(-CONSOLE_LOG_CONFIG.maxLines) : next;
        });
      } else if (msg.type === "lines") {
        setLogs((prev) => {
          const next = [...prev, ...msg.lines];
          return next.length > CONSOLE_LOG_CONFIG.maxLines ? next.slice(-CONSOLE_LOG_CONFIG.maxLines) : next;
        });
      } else if (msg.type === "clear") {
        setLogs([]);
      }
    };

    // EventSource retries on its own, but the UI previously showed only a
    // static "Connecting…" with no attempt count and no way to force a fresh
    // stream. Count failures for the status line; the Reconnect button below
    // tears this stream down (via cleanup) and opens a new one.
    es.onerror = () => {
      setConnected(false);
      setRetries((r) => r + 1);
    };

    return () => es.close();
  }, [connectKey]);

  // Auto-scroll to bottom on new logs
  useEffect(() => {
    if (!logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  return (
    <div className="">
      <p className="mb-3 text-xs text-text-muted">
        Live server console output — not per-request traffic. Request logs live in{" "}
        <a href="/dashboard/usage?tab=logs" className="font-medium text-primary hover:underline">Usage → Logs</a>.
      </p>
      <Card>
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <span className="flex items-center gap-1.5 text-xs text-text-muted">
            <span className={`h-[7px] w-[7px] rounded-full ${connected ? "bg-emerald-400" : "bg-zinc-500"}`} />
            {connected
              ? "Live"
              : retries > 0
                ? `Reconnecting… (attempt ${retries})`
                : "Connecting…"}
          </span>
          <div className="flex items-center gap-2">
            {!connected && (
              <Button size="sm" variant="outline" icon="refresh" onClick={() => setConnectKey((k) => k + 1)}>
                Reconnect
              </Button>
            )}
            <Button size="sm" variant="outline" icon="delete" onClick={handleClear}>
              Clear
            </Button>
          </div>
        </div>
        <div
          ref={logRef}
          className="bg-black rounded-b-lg px-3 py-2 text-xs font-mono h-[calc(100vh-220px)] overflow-y-auto"
        >
          {logs.length === 0 ? (
            <div className="text-text-muted space-y-1">
              <p>No console logs yet.</p>
              <p>
                Logs stream here live while the server runs — send a request
                through the router and entries appear. If this stays empty
                after traffic, the stream may have dropped: use Reconnect
                above, or refresh the page.
              </p>
            </div>
          ) : (
            <div>
              {logs.map((line, i) => (
                <LogRow key={i} line={line} />
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
