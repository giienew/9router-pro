"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Card from "@/shared/components/Card";

// R8 usage proof, inside the Usage page (no new page): an activity
// heatmap from the existing chart buckets, plus a savings view that reads
// the SAME /api/token-saver/stats source the Token Saver page uses —
// text + link, not a second savings page.
function fmtBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function UsageHeatmap() {
  const [buckets, setBuckets] = useState(null);
  useEffect(() => {
    fetch("/api/usage/chart?period=30d")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (Array.isArray(data)) setBuckets(data); })
      .catch(() => {});
  }, []);
  const max = buckets ? Math.max(1, ...buckets.map((b) => b.requests || 0)) : 1;
  return (
    <Card className="p-4">
      <h3 className="text-sm font-semibold">Activity — last 30 days</h3>
      <p className="text-xs text-text-muted mt-1">Requests per day, from existing usage history. Darker = busier.</p>
      {!buckets ? (
        <p className="text-sm text-text-muted mt-3">Loading…</p>
      ) : buckets.every((b) => !(b.requests || 0)) ? (
        <p className="text-sm text-text-muted mt-3">No requests in the last 30 days yet.</p>
      ) : (
        <div className="mt-3 grid grid-cols-7 gap-1 sm:grid-cols-10">
          {buckets.map((b, i) => {
            const ratio = (b.requests || 0) / max;
            const opacity = ratio === 0 ? 0.08 : 0.2 + ratio * 0.8;
            return (
              <div
                key={i}
                title={`${b.label}: ${b.requests || 0} requests, ${b.tokens || 0} tokens`}
                className="aspect-square rounded-sm bg-primary"
                style={{ opacity }}
              />
            );
          })}
        </div>
      )}
    </Card>
  );
}

export function SavingsProof() {
  const [stats, setStats] = useState(null);
  useEffect(() => {
    fetch("/api/token-saver/stats?days=14")
      .then((r) => (r.ok ? r.json() : null))
      .then(setStats)
      .catch(() => {});
  }, []);
  const t = stats?.totals;
  const savedBytes = t ? (t.bytesBefore || 0) - (t.bytesAfter || 0) : 0;
  const pct = t && t.bytesBefore > 0 ? ((savedBytes / t.bytesBefore) * 100).toFixed(1) : "0";
  return (
    <Card className="p-4">
      <h3 className="text-sm font-semibold">What usage saved you</h3>
      {!stats ? (
        <p className="text-sm text-text-muted mt-2">Loading…</p>
      ) : (
        <>
          <p className="mt-2 text-2xl font-bold">
            {fmtBytes(savedBytes)} <span className="text-sm font-medium text-text-muted">saved ({pct}%)</span>
          </p>
          <p className="text-xs text-text-muted mt-1">
            RTK byte savings over the last 14 days, counted on this instance only — the same numbers as the Token Saver page.
            {t?.requests ? ` Across ${t.requests} cached requests.` : ""}
          </p>
          <Link href="/dashboard/token-saver" className="mt-2 inline-block text-sm text-primary hover:underline">
            See the full Token Saver breakdown →
          </Link>
        </>
      )}
    </Card>
  );
}

export default function UsageProofSections() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <UsageHeatmap />
      <SavingsProof />
    </div>
  );
}
