"use client";

import { useCallback, useEffect, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import Card from "@/shared/components/Card";
import Badge from "@/shared/components/Badge";
import { countryFlag } from "@/shared/utils/clientMeta.js";

const API = "/api/spam-ranking";
const BLOCK_API = "/api/blocked-ips";

const PERIODS = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "all", label: "All" },
];

const fmt = (n) => new Intl.NumberFormat().format(n || 0);

function fmtTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString();
}

function fmtAgo(iso) {
  if (!iso) return "-";
  const diffMins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
  return new Date(iso).toLocaleDateString();
}

// Destructive action with a two-tap confirm: first tap arms it ("Sure?")
// for 3 seconds, second tap actually runs it.
function ConfirmButton({ label, icon, onConfirm, tone = "danger" }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  if (armed) {
    return (
      <button
        type="button"
        onClick={onConfirm}
        className="flex items-center gap-1 rounded-md bg-red-500 px-2 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-red-600"
      >
        <span className="material-symbols-outlined text-[16px]">warning</span>
        Sure?
      </button>
    );
  }
  const toneClass = tone === "danger"
    ? "hover:bg-red-500/10 hover:text-red-500"
    : "hover:bg-green-500/10 hover:text-green-600";
  return (
    <button
      type="button"
      onClick={() => setArmed(true)}
      title={`${label}. Tap twice to confirm.`}
      className={`flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-text-muted transition-colors hover:bg-black/5 hover:text-primary dark:hover:bg-white/5 ${toneClass}`}
    >
      <span className="material-symbols-outlined text-[16px]">{icon}</span>
      {label}
    </button>
  );
}

function FlagIp({ flag, ip, country }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-xs">
      <span className="shrink-0 text-base leading-none">{flag || countryFlag(country) || "🌐"}</span>
      <span className="truncate">{ip}</span>
      {country && country !== "unknown" && (
        <span className="shrink-0 text-text-muted">({country})</span>
      )}
    </span>
  );
}

function TrendChart({ series }) {
  const hasData = (series || []).some((d) => (d.requests || 0) > 0);
  if (!series || !hasData) {
    return (
      <div className="flex h-44 items-center justify-center text-sm text-text-muted">
        No requests in this period yet.
      </div>
    );
  }
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-4 text-xs text-text-muted">
        <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full bg-[#8B5CF6]" />Requests</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full bg-red-500" />Errors</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full bg-amber-500" />429s</span>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="spamReq" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#8B5CF6" stopOpacity={0.38} />
              <stop offset="95%" stopColor="#8B5CF6" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="spamErr" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="spam429" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }} tickLine={false} axisLine={false} width={40} allowDecimals={false} />
          <Tooltip
            contentStyle={{ backgroundColor: "var(--color-bg)", border: "none", borderRadius: "8px", fontSize: "12px" }}
          />
          <Area type="monotone" dataKey="requests" stroke="#8B5CF6" strokeWidth={2} fill="url(#spamReq)" dot={false} activeDot={{ r: 4 }} />
          <Area type="monotone" dataKey="errors" stroke="#ef4444" strokeWidth={1.5} fill="url(#spamErr)" dot={false} activeDot={{ r: 3 }} />
          <Area type="monotone" dataKey="rate429" stroke="#f59e0b" strokeWidth={1.5} fill="url(#spam429)" dot={false} activeDot={{ r: 3 }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function SpamRankingClient() {
  const [period, setPeriod] = useState("7d");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyIp, setBusyIp] = useState(null);

  const load = useCallback(async (p) => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API}?period=${encodeURIComponent(p)}`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || `Failed to load (${res.status})`);
      setData(json);
    } catch (e) {
      setError(e?.message || "Failed to load spam ranking");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(period); }, [period, load]);

  const blockedSet = new Set((data?.blocked || []).map((b) => b.ip));

  async function blockIp(ip, country) {
    setBusyIp(ip);
    try {
      const res = await fetch(BLOCK_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip, country }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || `Block failed (${res.status})`);
      await load(period);
    } catch (e) {
      setError(e?.message || "Block failed");
    } finally {
      setBusyIp(null);
    }
  }

  async function unblockIp(ip) {
    setBusyIp(ip);
    try {
      const res = await fetch(`${BLOCK_API}?ip=${encodeURIComponent(ip)}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || `Unblock failed (${res.status})`);
      await load(period);
    } catch (e) {
      setError(e?.message || "Unblock failed");
    } finally {
      setBusyIp(null);
    }
  }

  const totals = data?.totals || {};
  const byIp = data?.byIp || [];
  const byKey = data?.byKey || [];
  const recent = data?.recent || [];
  const blocked = data?.blocked || [];
  const series = data?.series || [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-text-main">Spam / Abuse</h1>
        <div className="flex items-center gap-1 rounded-lg border border-border-subtle bg-surface p-1">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => setPeriod(p.value)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                period === p.value
                  ? "bg-brand-500 text-white"
                  : "text-text-muted hover:text-text-main"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <Card padding="sm">
          <p className="text-sm text-red-500">{error}</p>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Requests", value: fmt(totals.requests) },
          { label: "Errors", value: fmt(totals.errors) },
          { label: "429s", value: fmt(totals.rate429) },
          { label: "Unique IPs", value: fmt(totals.uniqueIps) },
        ].map((s) => (
          <Card key={s.label} padding="sm">
            <p className="text-xs text-text-muted">{s.label}</p>
            <p className="text-xl font-semibold text-text-main">{s.value}</p>
          </Card>
        ))}
      </div>

      <Card title="Traffic trend" subtitle="Requests, errors and 429s over time.">
        {loading && !data ? (
          <p className="text-sm text-text-muted">Loading…</p>
        ) : (
          <TrendChart series={series} />
        )}
      </Card>

      <Card title="Top spammers by IP" subtitle="Tap Blacklist to block an IP. Two taps to confirm.">
        {loading && !data ? (
          <p className="text-sm text-text-muted">Loading…</p>
        ) : byIp.length === 0 ? (
          <p className="text-sm text-text-muted">No requests in this period yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-text-muted">
                  <th className="px-2 py-2">#</th>
                  <th className="px-2 py-2">IP</th>
                  <th className="px-2 py-2 text-right">Requests</th>
                  <th className="px-2 py-2 text-right">Errors</th>
                  <th className="hidden px-2 py-2 text-right sm:table-cell">429s</th>
                  <th className="hidden px-2 py-2 md:table-cell">First seen</th>
                  <th className="hidden px-2 py-2 md:table-cell">Last seen</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {byIp.map((row) => (
                  <tr key={row.ip} className="border-t border-border-subtle">
                    <td className="px-2 py-2 font-semibold">{row.rank}</td>
                    <td className="max-w-[140px] px-2 py-2 sm:max-w-none"><FlagIp flag={row.flag} ip={row.ip} country={row.country} /></td>
                    <td className="px-2 py-2 text-right font-medium">{fmt(row.requests)}</td>
                    <td className="px-2 py-2 text-right">{fmt(row.errors)}</td>
                    <td className="hidden px-2 py-2 text-right sm:table-cell">{fmt(row.rate429)}</td>
                    <td className="hidden px-2 py-2 text-text-muted md:table-cell">{fmtAgo(row.firstSeen)}</td>
                    <td className="hidden px-2 py-2 text-text-muted md:table-cell">{fmtAgo(row.lastSeen)}</td>
                    <td className="px-2 py-2 text-right">
                      {blockedSet.has(row.ip) || row.ip === "unknown" ? (
                        blockedSet.has(row.ip) ? <Badge variant="error" size="sm">Blocked</Badge> : <span className="text-xs text-text-muted">-</span>
                      ) : (
                        <ConfirmButton
                          label={busyIp === row.ip ? "Blocking…" : "Blacklist"}
                          icon="block"
                          onConfirm={() => blockIp(row.ip, row.country)}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-text-muted">VPN or proxied requests may show as unknown.</p>
      </Card>

      <Card title="Top callers by API key" subtitle="Masked keys only.">
        {loading && !data ? (
          <p className="text-sm text-text-muted">Loading…</p>
        ) : byKey.length === 0 ? (
          <p className="text-sm text-text-muted">No requests in this period yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-text-muted">
                  <th className="px-2 py-2">#</th>
                  <th className="px-2 py-2">API key</th>
                  <th className="px-2 py-2 text-right">Requests</th>
                  <th className="px-2 py-2 text-right">Errors</th>
                  <th className="hidden px-2 py-2 text-right sm:table-cell">429s</th>
                  <th className="hidden px-2 py-2 md:table-cell">First seen</th>
                  <th className="hidden px-2 py-2 md:table-cell">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {byKey.map((row) => (
                  <tr key={row.apiKeyMasked} className="border-t border-border-subtle">
                    <td className="px-2 py-2 font-semibold">{row.rank}</td>
                    <td className="px-2 py-2 font-mono text-xs">{row.apiKeyMasked}</td>
                    <td className="px-2 py-2 text-right font-medium">{fmt(row.requests)}</td>
                    <td className="px-2 py-2 text-right">{fmt(row.errors)}</td>
                    <td className="hidden px-2 py-2 text-right sm:table-cell">{fmt(row.rate429)}</td>
                    <td className="hidden px-2 py-2 text-text-muted md:table-cell">{fmtAgo(row.firstSeen)}</td>
                    <td className="hidden px-2 py-2 text-text-muted md:table-cell">{fmtAgo(row.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Blacklisted IPs" subtitle="Blocked IPs get a 403 on every public LLM endpoint.">
        {blocked.length === 0 ? (
          <p className="text-sm text-text-muted">No blocked IPs.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-text-muted">
                  <th className="px-2 py-2">IP</th>
                  <th className="hidden px-2 py-2 sm:table-cell">Blocked at</th>
                  <th className="hidden px-2 py-2 sm:table-cell">Blocked by</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {blocked.map((b) => (
                  <tr key={b.ip} className="border-t border-border-subtle">
                    <td className="max-w-[160px] px-2 py-2 sm:max-w-none"><FlagIp flag={b.flag} ip={b.ip} country={b.country} /></td>
                    <td className="hidden px-2 py-2 text-text-muted sm:table-cell">{fmtTime(b.blockedAt)}</td>
                    <td className="hidden px-2 py-2 text-text-muted sm:table-cell">{b.blockedBy || "dashboard"}</td>
                    <td className="px-2 py-2 text-right">
                      <ConfirmButton
                        label={busyIp === b.ip ? "Unblocking…" : "Unblacklist"}
                        icon="lock_open"
                        tone="safe"
                        onConfirm={() => unblockIp(b.ip)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Recent requests" subtitle="Newest first.">
        {loading && !data ? (
          <p className="text-sm text-text-muted">Loading…</p>
        ) : recent.length === 0 ? (
          <p className="text-sm text-text-muted">No requests yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm sm:min-w-0">
              <thead>
                <tr className="text-left text-xs text-text-muted">
                  <th className="px-2 py-2">Time</th>
                  <th className="px-2 py-2">IP</th>
                  <th className="hidden px-2 py-2 sm:table-cell">API key</th>
                  <th className="hidden px-2 py-2 md:table-cell">Model</th>
                  <th className="px-2 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r, i) => (
                  <tr key={`${r.timestamp}-${i}`} className="border-t border-border-subtle">
                    <td className="whitespace-nowrap px-2 py-2 text-text-muted">{fmtTime(r.timestamp)}</td>
                    <td className="max-w-[140px] px-2 py-2 sm:max-w-none"><FlagIp flag={r.flag} ip={r.clientIp} country={r.country} /></td>
                    <td className="hidden px-2 py-2 font-mono text-xs sm:table-cell">{r.apiKeyMasked || "-"}</td>
                    <td className="hidden max-w-[160px] truncate px-2 py-2 md:table-cell">{r.model}</td>
                    <td className="px-2 py-2">
                      <Badge variant={r.status === "ok" || r.status === "success" ? "success" : "error"} size="sm">
                        {r.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-text-muted">VPN or proxied requests may show as unknown.</p>
      </Card>
    </div>
  );
}
