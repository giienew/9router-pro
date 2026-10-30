"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, Badge, CardSkeleton } from "@/shared/components";

// Dashboard home overview (G1). Distinct from Endpoint: at-a-glance health,
// usage, and counts plus quick links. Every fetch is defensive — a failed
// source renders as "—" instead of breaking the page, and no key material
// is ever rendered here (only counts).

function sumUsage(stats) {
  if (!stats || typeof stats !== "object") return null;
  const buckets = stats.byModel || stats.byProvider || null;
  if (!buckets) return null;
  let requests = 0;
  let tokens = 0;
  let seen = false;
  for (const v of Object.values(buckets)) {
    if (!v || typeof v !== "object") continue;
    seen = true;
    requests += v.requests || 0;
    tokens += v.totalTokens || (v.promptTokens || 0) + (v.completionTokens || 0);
  }
  return seen ? { requests, tokens } : null;
}

function sumSummary(statsMap) {
  let providers = 0;
  let connected = 0;
  let error = 0;
  let total = 0;
  for (const s of Object.values(statsMap || {})) {
    providers += 1;
    connected += s?.connected || 0;
    error += s?.error || 0;
    total += s?.total || 0;
  }
  return { providers, connected, error, total };
}

const QUICK_LINKS = [
  { href: "/dashboard/endpoint", icon: "api", label: "Endpoint & Keys", desc: "Create keys, copy your base URL" },
  { href: "/dashboard/providers", icon: "dns", label: "Providers", desc: "Connect and manage providers" },
  { href: "/dashboard/combos", icon: "layers", label: "Combos", desc: "Build model combos with fallback" },
  { href: "/dashboard/usage", icon: "bar_chart", label: "Usage", desc: "Requests, tokens, and logs" },
  { href: "/dashboard/quota", icon: "data_usage", label: "Provider Quota", desc: "Provider-side balances per connection" },
  { href: "/dashboard/token-saver", icon: "savings", label: "Token Saver", desc: "Compress prompts and save tokens" },
];

export default function DashboardOverview() {
  const [summary, setSummary] = useState(null);
  const [breakers, setBreakers] = useState(null);
  const [keyCount, setKeyCount] = useState(null);
  const [comboCount, setComboCount] = useState(null);
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const get = async (url) => {
        try {
          const res = await fetch(url, { cache: "no-store" });
          return res.ok ? await res.json() : null;
        } catch {
          return null;
        }
      };
      const [prov, keys, combos, stats] = await Promise.all([
        get("/api/providers?summary=1"),
        get("/api/keys"),
        get("/api/combos"),
        get("/api/usage/stats?period=today"),
      ]);
      if (cancelled) return;
      if (prov?.stats) setSummary(sumSummary(prov.stats));
      if (prov?.breakers) setBreakers(prov.breakers);
      if (Array.isArray(keys)) setKeyCount(keys.length);
      else if (Array.isArray(keys?.keys)) setKeyCount(keys.keys.length);
      if (Array.isArray(combos)) setComboCount(combos.length);
      else if (Array.isArray(combos?.combos)) setComboCount(combos.combos.length);
      setUsage(sumUsage(stats));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const breakerOpen = breakers
    ? Object.values(breakers).filter((b) => b?.state === "open" || b?.state === "half-open").length
    : null;
  const healthLabel = !summary
    ? "Health data unavailable"
    : summary.error > 0
      ? `${summary.error} connection${summary.error === 1 ? "" : "s"} reporting errors`
      : summary.connected > 0
        ? "All reporting connections healthy"
        : "No connections yet";

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Provider health</p>
          <p className="mt-2 text-2xl font-semibold">
            {summary ? `${summary.connected} connected` : "—"}
          </p>
          <p className="mt-1 text-xs text-text-muted">{healthLabel}</p>
          {breakerOpen !== null && breakerOpen > 0 && (
            <p className="mt-2">
              <Badge variant="warning" size="sm">
                {breakerOpen} breaker{breakerOpen === 1 ? "" : "s"} tripped — see Providers
              </Badge>
            </p>
          )}
        </Card>
        <Card>
          <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Usage today</p>
          <p className="mt-2 text-2xl font-semibold">
            {usage ? `${usage.requests.toLocaleString()} requests` : "—"}
          </p>
          <p className="mt-1 text-xs text-text-muted">
            {usage ? `~${usage.tokens.toLocaleString()} tokens` : "No usage data for today yet"}
          </p>
          <Link href="/dashboard/usage" className="mt-2 inline-block text-xs font-medium text-primary hover:underline">
            View usage →
          </Link>
        </Card>
        <Card>
          <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">API keys</p>
          <p className="mt-2 text-2xl font-semibold">{keyCount ?? "—"}</p>
          <p className="mt-1 text-xs text-text-muted">
            {keyCount === 0 ? "Create your first key to start calling the API." : "Keys ready to call /v1."}
          </p>
          <Link href="/dashboard/endpoint" className="mt-2 inline-block text-xs font-medium text-primary hover:underline">
            Manage keys →
          </Link>
        </Card>
        <Card>
          <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Combos</p>
          <p className="mt-2 text-2xl font-semibold">{comboCount ?? "—"}</p>
          <p className="mt-1 text-xs text-text-muted">
            {comboCount === 0 ? "Combine models with fallback for reliability." : "Model combos configured."}
          </p>
          <Link href="/dashboard/combos" className="mt-2 inline-block text-xs font-medium text-primary hover:underline">
            Manage combos →
          </Link>
        </Card>
      </div>

      {summary && summary.total === 0 && (
        <Card>
          <p className="text-sm font-medium">Get started</p>
          <p className="mt-1 text-sm text-text-muted">
            No providers connected yet. Connect a provider, then create an API key on the{" "}
            <Link href="/dashboard/endpoint" className="font-medium text-primary hover:underline">Endpoint</Link>{" "}
            page to send your first request.
          </p>
        </Card>
      )}

      <div>
        <h2 className="mb-3 text-sm font-semibold text-text-main">Quick links</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {QUICK_LINKS.map((link) => (
            <Link key={link.href} href={link.href}>
              <Card className="h-full transition-colors hover:bg-surface-2">
                <div className="flex items-center gap-3">
                  <span className="material-symbols-outlined text-primary">{link.icon}</span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{link.label}</p>
                    <p className="truncate text-xs text-text-muted">{link.desc}</p>
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
