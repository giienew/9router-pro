"use client";

import { useState, useEffect, useRef } from "react";
import { Card, Button } from "@/shared/components";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config";
import { parseConsoleLine } from "@/lib/logLineParse";

// MatLog-style rows (9Router Pro): every line renders as time + level
// badge + short tag + one plain message, so the panel scans like a
// logcat viewer instead of a wall of green terminal text.
const LEVEL_BADGES = {
  E: "bg-red-500/15 text-red-400 border-red-500/25",
  W: "bg-amber-500/15 text-amber-400 border-amber-500/25",
  I: "bg-blue-500/15 text-blue-400 border-blue-500/25",
  D: "bg-purple-500/15 text-purple-400 border-purple-500/25",
  "✓": "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
  "·": "bg-zinc-500/15 text-zinc-400 border-zinc-500/25",
};

function LogRow({ line }) {
  const p = parseConsoleLine(line);
  const badge = LEVEL_BADGES[p.level] || LEVEL_BADGES["·"];
  return (
    <div className="flex items-start gap-2 border-b border-white/5 py-[3px] last:border-0">
      <span className="w-[52px] shrink-0 pt-[2px] text-zinc-500">{p.time || "—"}</span>
      <span className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[4px] border text-[10px] font-bold ${badge}`}>
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

    es.onopen = () => setConnected(true);

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

    es.onerror = () => setConnected(false);

    return () => es.close();
  }, []);

  // Auto-scroll to bottom on new logs
  useEffect(() => {
    if (!logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  return (
    <div className="">
      <Card>
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <span className="flex items-center gap-1.5 text-xs text-text-muted">
            <span className={`h-[7px] w-[7px] rounded-full ${connected ? "bg-emerald-400" : "bg-zinc-500"}`} />
            {connected ? "Live" : "Connecting…"}
          </span>
          <Button size="sm" variant="outline" icon="delete" onClick={handleClear}>
            Clear
          </Button>
        </div>
        <div
          ref={logRef}
          className="bg-black rounded-b-lg px-3 py-2 text-xs font-mono h-[calc(100vh-220px)] overflow-y-auto"
        >
          {logs.length === 0 ? (
            <span className="text-text-muted">No console logs yet.</span>
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
