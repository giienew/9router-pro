"use client";

import { useState, useEffect, useCallback } from "react";
import Card from "@/shared/components/Card";
import { AI_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers";

function fmtMs(v) {
  if (v === null || v === undefined) return "—";
  if (v < 1000) return `${Math.round(v)}ms`;
  return `${(v / 1000).toFixed(1)}s`;
}

const MAP = { today: "24h", "24h": "24h", "7d": "7d", "30d": "30d", "60d": "all", all: "all", custom: "all" };

export default function LatencyCard({ period = "7d" }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [nodeMap, setNodeMap] = useState({});

  // Custom node id -> node name for the by-provider rows (same pattern as
  // the Logs tab). Built-ins fall back to their display names, then raw id.
  useEffect(() => {
    fetch("/api/provider-nodes")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const map = {};
        for (const n of d?.nodes || []) if (n.id && n.name) map[n.id] = n.name;
        setNodeMap(map);
      })
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/usage/latency?period=${MAP[period] || "7d"}`);
      if (!res.ok) throw new Error("failed");
      setData(await res.json());
      setError("");
    } catch {
      setError("Latency stats unavailable");
    }
  }, [period]);

  useEffect(() => { load(); }, [load]);

  const displayProvider = (raw) => nodeMap[raw] || getProviderByAlias(raw)?.name || AI_PROVIDERS[raw]?.name || raw;
  const providers = data ? Object.entries(data.byProvider || {}).map(([raw, v]) => ({ name: displayProvider(raw), raw, v })).sort((a, b) => b.v.samples - a.v.samples).slice(0, 5) : [];

  return (
    <Card title="Latency" subtitle="TTFT + total time, p50/p95 from request details" icon="speed">
      {error && <p className="text-xs text-red-500">{error}</p>}
      {!data && !error && <p className="text-xs text-text-muted">Loading…</p>}
      {data && data.samples === 0 && (
        <div>
          {data.observabilityEnabled === false ? (
            <>
              <p className="text-xs text-text-muted">Request details are <span className="font-semibold text-text-main">off</span> — nothing is being recorded, so this card stays empty.</p>
              <p className="mt-1 text-xs text-text-muted">
                Turn on <span className="font-medium text-text-main">Observability</span> in{" "}
                <a href="/dashboard/profile" className="font-medium text-primary underline">Profile</a>{" "}
                and new requests will appear here.
              </p>
            </>
          ) : (
            <>
              <p className="text-xs text-text-muted">No latency data yet — it accrues from requests served after this feature landed.</p>
              <a href="/dashboard/endpoint" className="mt-1 inline-block text-xs font-medium text-primary hover:underline">
                Send a request, then check back →
              </a>
            </>
          )}
        </div>
      )}
      {data && data.samples > 0 && (
        <div className="flex flex-col gap-3">
          {data.period === "all" && (
            <p className="text-xs text-text-muted">Window: all recorded details (latest 5,000) — the 60-day / all / custom views share this window.</p>
          )}
          {data.period === "24h" && (
            <p className="text-xs text-text-muted">Window: last 24 hours.</p>
          )}
          {data.period === "7d" && (
            <p className="text-xs text-text-muted">Window: last 7 days.</p>
          )}
          {data.period === "30d" && (
            <p className="text-xs text-text-muted">Window: last 30 days.</p>
          )}
          <div className="flex flex-wrap gap-6 text-sm">
            <span>Requests <b className="font-mono">{data.samples}</b></span>
            <span>TTFT p50 <b className="font-mono">{fmtMs(data.ttft.p50)}</b></span>
            <span>TTFT p95 <b className="font-mono">{fmtMs(data.ttft.p95)}</b></span>
            <span>Total p50 <b className="font-mono">{fmtMs(data.total.p50)}</b></span>
            <span>Total p95 <b className="font-mono">{fmtMs(data.total.p95)}</b></span>
          </div>
          {providers.length > 0 && (
            <div className="flex flex-col gap-1 text-xs">
              {providers.map(({ name, raw, v }) => (
                <div key={raw} className="flex flex-wrap justify-between gap-x-4 gap-y-0.5">
                  <span className="text-text-muted min-w-0">{name} ({v.samples})</span>
                  <span className="font-mono min-w-0">total p50 {fmtMs(v.totalP50)} · p95 {fmtMs(v.totalP95)} · ttft p50 {fmtMs(v.ttftP50)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
