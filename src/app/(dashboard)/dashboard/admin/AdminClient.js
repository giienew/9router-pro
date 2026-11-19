"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, Button, ConfirmModal, Badge } from "@/shared/components";
import { formatBytes } from "@/shared/utils/adminHelpers.js";
import SpamRankingClient from "../spam/SpamRankingClient";

const fmtTime = (iso) => {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString();
};

const fmtAgo = (iso) => {
  if (!iso) return "-";
  const diff = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (diff < 1) return "Just now";
  if (diff < 60) return `${diff}m ago`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h ago`;
  return new Date(iso).toLocaleDateString();
};

const fmtUptime = (sec) => {
  const s = Number(sec) || 0;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

async function fetchJson(url, opts) {
  const res = await fetch(url, { cache: "no-store", ...opts });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
  return json;
}

function StatusDot({ ok }) {
  return (
    <span
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${ok ? "bg-green-500" : "bg-red-500"}`}
      title={ok ? "OK" : "Attention"}
    />
  );
}

// Big number + tiny label. Values wrap, never truncate.
function Stat({ label, value, sub }) {
  return (
    <div className="min-w-0 rounded-xl bg-bg px-3 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">{label}</div>
      <div className="mt-1 break-words text-base font-bold leading-snug text-text-main">{value ?? "-"}</div>
      {sub ? <div className="mt-0.5 break-words text-[11px] leading-snug text-text-muted">{sub}</div> : null}
    </div>
  );
}

// Small requests sparkline. Reuses the spam-ranking series (same gradient
// language as the Usage chart). No new dependency.
function TrafficSpark({ series }) {
  const hasData = (series || []).some((d) => (d.requests || 0) > 0);
  if (!series || !hasData) {
    return <div className="flex h-24 items-center justify-center text-sm text-text-muted">No requests yet.</div>;
  }
  return (
    <ResponsiveContainer width="100%" height={110}>
      <AreaChart data={series} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="adminReq" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#8B5CF6" stopOpacity={0.38} />
            <stop offset="95%" stopColor="#8B5CF6" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="label" tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
        <YAxis tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }} tickLine={false} axisLine={false} width={36} allowDecimals={false} />
        <Tooltip contentStyle={{ backgroundColor: "var(--color-bg)", border: "none", borderRadius: "8px", fontSize: "12px" }} />
        <Area type="monotone" dataKey="requests" stroke="#8B5CF6" strokeWidth={2} fill="url(#adminReq)" dot={false} activeDot={{ r: 3 }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// One confirm modal drives every maintenance action.
const MAINTENANCE_ACTIONS = [
  { id: "clear-all-caches", icon: "cleaning_services", title: "Clear all caches", confirmTitle: "Clear all caches?", confirmMessage: "Clears the semantic cache (all models), the models-list cache, latency stats and the monitoring cache. In-flight requests are unaffected; the next requests just rebuild the caches." },
  { id: "clear-semantic", icon: "psychology", title: "Clear semantic cache", confirmTitle: "Clear semantic cache?", confirmMessage: "Removes every entry from the semantic (similar-prompt) cache. Cached answers will be recomputed on the next matching prompt." },
  { id: "reset-breakers", icon: "power", title: "Reset all breakers", danger: true, confirmTitle: "Reset ALL provider breakers?", confirmMessage: "This clears every open / half-open breaker and all per-model cooldowns at once. Every provider is immediately retried. Only do this after the upstream outage is actually over, or the failures will trip the breakers again." },
  { id: "refresh-tokens", icon: "autorenew", title: "Refresh tokens now", confirmTitle: "Run token refresh now?", confirmMessage: "Runs one background refresh tick immediately for every OAuth connection whose token is close to expiry. Safe to run any time." },
  { id: "vacuum", icon: "database", title: "VACUUM database", confirmTitle: "VACUUM the database?", confirmMessage: "Runs SQLite VACUUM to reclaim free space. It briefly locks the database. Requests may wait a moment on a large DB." },
  { id: "backup-now", icon: "backup", title: "Backup now", confirmTitle: "Create a backup now?", confirmMessage: "Takes a timestamped snapshot of the current database export. It appears in the Settings backup list and restores through the normal import path." },
  { id: "disk-cleanup", icon: "delete_sweep", title: "Disk cleanup", confirmTitle: "Run disk cleanup?", confirmMessage: "Deletes deploy tarballs older than the newest two, DB safety backups older than the newest three, and auto-backup snapshots beyond the configured keep count. The newest backups, the restore path, are never touched." },
  { id: "clear-logs", icon: "article", title: "Clear console log", confirmTitle: "Clear the console log buffer?", confirmMessage: "Empties the in-memory console log shown on the Console Log page. PM2 on-disk logs are untouched. Use Flush PM2 logs for those." },
  { id: "clear-pm2-logs", icon: "description", title: "Flush PM2 logs", confirmTitle: "Flush PM2 logs?", confirmMessage: "Runs pm2 flush, truncating the on-disk logs of every PM2 process. Only works where PM2 manages the app." },
];

export default function AdminClient() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [system, setSystem] = useState(null);
  const [health, setHealth] = useState(null);
  const [monitoring, setMonitoring] = useState(null);
  const [security, setSecurity] = useState(null);
  const [keys, setKeys] = useState([]);
  const [series, setSeries] = useState(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(null);
  const [pending, setPending] = useState(null);
  const [pendingKey, setPendingKey] = useState(null);
  const [restartState, setRestartState] = useState(null);
  const restartTimer = useRef(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [sys, hlth, mon, sec, keyData, spam] = await Promise.all([
        fetchJson("/api/admin/system").catch((e) => { throw new Error(`System status: ${e.message}`); }),
        fetchJson("/api/health").catch(() => null),
        fetchJson("/api/monitoring").catch(() => null),
        fetchJson("/api/admin/security").catch((e) => { throw new Error(`Security center: ${e.message}`); }),
        fetchJson("/api/keys").catch(() => ({ keys: [] })),
        fetchJson("/api/spam-ranking?period=7d").catch(() => null),
      ]);
      setSystem(sys);
      setHealth(hlth);
      setMonitoring(mon);
      setSecurity(sec);
      setKeys(keyData?.keys || []);
      setSeries(spam?.series || null);
    } catch (e) {
      setError(e?.message || "Failed to load Admin");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);
  useEffect(() => () => { if (restartTimer.current) clearInterval(restartTimer.current); }, []);

  async function refreshSecurity() {
    try { setSecurity(await fetchJson("/api/admin/security")); } catch {}
  }

  async function runMaintenance(actionId, extra = {}) {
    setBusy(actionId);
    setNotice("");
    try {
      const json = await fetchJson("/api/admin/maintenance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: actionId, ...extra }),
      });
      const r = json?.result || {};
      let msg = `${actionId} done.`;
      if (actionId === "clear-semantic" || actionId === "clear-all-caches") {
        const n = actionId === "clear-semantic" ? r.removed : r?.semantic?.removed;
        msg = `Semantic cache cleared. ${n ?? 0} entries removed.`;
      } else if (actionId === "clear-latency") msg = `Latency cache cleared. ${r.cleared ?? 0} cached periods dropped.`;
      else if (actionId === "clear-monitoring") msg = `Monitoring cache ${r.cleared ? "cleared" : "was already empty"}.`;
      else if (actionId === "clear-models") msg = "Models caches cleared.";
      else if (actionId === "clear-logs") msg = `Console log buffer cleared. ${r.clearedLines ?? 0} lines removed.`;
      else if (actionId === "clear-pm2-logs") msg = "PM2 logs flushed.";
      else if (actionId === "reset-breakers") msg = `Breakers reset. ${r.resetProviders ?? 0} provider(s) re-opened.`;
      else if (actionId === "vacuum") msg = `VACUUM ${r.vacuum}${r.freedBytes != null ? `, freed ${formatBytes(r.freedBytes)}` : ""}.`;
      else if (actionId === "backup-now") msg = `Backup created. ${r?.snapshot?.id || "snapshot saved"}.`;
      else if (actionId === "disk-cleanup") msg = `Disk cleanup freed ${formatBytes(r.freedBytes || 0)}.`;
      else if (actionId === "refresh-tokens") msg = `Token refresh tick done. ${r.dueConnections ?? 0} connection(s) were due.`;
      setNotice(msg);
      await refreshSecurity();
    } catch (e) {
      setNotice(`Failed: ${e?.message || actionId}`);
    } finally {
      setBusy(null);
      setPending(null);
    }
  }

  async function doRestart() {
    setBusy("restart");
    setNotice("");
    setRestartState({ phase: "waiting", buildId: system?.buildId || null });
    try {
      const json = await fetchJson("/api/admin/maintenance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restart" }),
      });
      setNotice(`Restarting PM2 process "${json?.process || "9router-pro"}". Waiting for it to come back.`);
      const beforeBuild = system?.buildId;
      const startedAt = Date.now();
      restartTimer.current = setInterval(async () => {
        if (Date.now() - startedAt > 90000) {
          clearInterval(restartTimer.current);
          setRestartState({ phase: "timeout", buildId: beforeBuild });
          setNotice("Restart: no response after 90s. Check the System status card or PM2 on the host.");
          setBusy(null);
          return;
        }
        try {
          const sys = await fetchJson("/api/admin/system");
          setSystem(sys);
          if (sys?.buildId && beforeBuild && sys.buildId !== beforeBuild) {
            clearInterval(restartTimer.current);
            setRestartState({ phase: "back", buildId: sys.buildId });
            setNotice(`Back online. New BUILD_ID ${sys.buildId}.`);
            setBusy(null);
          } else if (sys?.appUptimeSec != null && sys.appUptimeSec < 60) {
            clearInterval(restartTimer.current);
            setRestartState({ phase: "back", buildId: sys?.buildId || null });
            setNotice(`Back online. App uptime ${sys.appUptimeSec}s${sys?.buildId ? `, BUILD_ID ${sys.buildId}` : ""}.`);
            setBusy(null);
          }
        } catch {}
      }, 3000);
    } catch (e) {
      setRestartState(null);
      setNotice(`Restart failed: ${e?.message || "unknown error"}`);
      setBusy(null);
    } finally {
      setPending(null);
    }
  }

  async function revokeSessions() {
    setBusy("revoke");
    try {
      const json = await fetchJson("/api/admin/sessions/revoke", { method: "POST" });
      setNotice(`All other dashboard sessions revoked (token epoch ${json?.tokenVersion}). This session was re-issued and stays logged in.`);
      await refreshSecurity();
    } catch (e) {
      setNotice(`Revoke failed: ${e?.message || "unknown error"}`);
    } finally {
      setBusy(null);
      setPending(null);
    }
  }

  async function unlockIp(ip) {
    setBusy(`unlock-${ip}`);
    try {
      await fetchJson("/api/admin/security", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unlock", ip }),
      });
      setNotice(`Lockout cleared for ${ip}.`);
      await refreshSecurity();
    } catch (e) {
      setNotice(`Unlock failed: ${e?.message || "unknown error"}`);
    } finally {
      setBusy(null);
    }
  }

  async function keyAction(key, kind) {
    setBusy(`${kind}-${key.id}`);
    try {
      if (kind === "pause" || kind === "resume") {
        await fetchJson(`/api/keys/${key.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive: kind === "resume" }),
        });
        setNotice(`Key "${key.name}" ${kind === "pause" ? "paused" : "resumed"}.`);
      } else if (kind === "regenerate") {
        await fetchJson(`/api/keys/${key.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ regenerate: true }),
        });
        setNotice(`Key "${key.name}" regenerated. The new value is NOT shown anywhere (masked-only reads). Update your clients from the Endpoint page, which shows the one-time value on creation only.`);
      } else if (kind === "reset-usage") {
        await fetchJson(`/api/keys/${key.id}/reset`, { method: "POST" });
        setNotice(`Usage counter reset for "${key.name}".`);
      }
      const data = await fetchJson("/api/keys");
      setKeys(data?.keys || []);
    } catch (e) {
      setNotice(`Key action failed: ${e?.message || "unknown error"}`);
    } finally {
      setBusy(null);
      setPendingKey(null);
    }
  }

  const enc = security?.encryption;
  const locked = (security?.lockouts || []).filter((l) => l.locked);
  const pm2Target = system?.pm2?.target;
  const restartLabel = restartState?.phase === "back" ? "Back online" : restartState?.phase === "waiting" ? "Restarting" : restartState?.phase === "timeout" ? "No response (90s)" : "-";

  return (
    <div className="flex min-w-0 flex-col gap-4 px-1 sm:px-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-text-main">Admin</h1>
        <Button variant="secondary" size="sm" icon="refresh" onClick={loadAll} loading={loading}>Refresh</Button>
      </div>

      {error && (
        <Card><p className="text-sm text-red-500">{error}</p></Card>
      )}
      {notice && (
        <Card><p className="text-sm text-text-main">{notice}</p></Card>
      )}

      <Card title="System status" subtitle="Live" icon="monitor_heart">
        {loading && !system ? (
          <p className="text-sm text-text-muted">Loading…</p>
        ) : system ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Version" value={system.version ? `v${system.version}` : "-"} sub={system.buildId ? `BUILD ${system.buildId.slice(0, 12)}` : "BUILD unknown"} />
            <Stat label="App uptime" value={fmtUptime(system.appUptimeSec)} sub={`Host ${fmtUptime(system.uptimeSec)}`} />
            <Stat label="Memory" value={system.memory ? `${formatBytes(system.memory.totalBytes - system.memory.freeBytes)} / ${formatBytes(system.memory.totalBytes)}` : "-"} sub={system.memory ? `RSS ${formatBytes(system.memory.rssBytes)}` : ""} />
            <Stat label="Disk" value={system.disk ? `${formatBytes(system.disk.usedBytes)} / ${formatBytes(system.disk.totalBytes)}` : "-"} sub={system.disk ? `${formatBytes(system.disk.availBytes)} free` : "df unavailable"} />
            <Stat label="PM2" value={system.pm2?.available ? (pm2Target ? pm2Target.status || "online" : "No 9router process") : "Not available"} sub={pm2Target ? pm2Target.name : system.pm2?.available ? `${(system.pm2.processes || []).length} process(es)` : "Restart unavailable here"} />
          </div>
        ) : (
          <p className="text-sm text-text-muted">System status unavailable.</p>
        )}
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">Requests, last 7 days</span>
            {restartState?.phase ? <span className="text-[11px] text-text-muted">Restart: {restartLabel}</span> : null}
          </div>
          <TrafficSpark series={series} />
        </div>
      </Card>

      <Card title="Security center" subtitle="Encryption, lockouts, sessions." icon="shield">
        <div className="grid gap-3 lg:grid-cols-3">
          <div className="rounded-xl bg-bg p-4">
            <div className="flex items-center gap-2">
              <StatusDot ok={!!enc?.configured} />
              <h4 className="font-semibold text-text-main">Encryption</h4>
              <Badge>{enc?.configured ? "Key set" : "Key NOT set"}</Badge>
            </div>
            <p className="mt-2 text-2xl font-bold text-text-main">
              {enc?.configured ? `${enc.encrypted} encrypted` : "Plaintext"}
            </p>
            <p className="text-xs text-text-muted">
              {enc?.configured ? `${enc.plaintext} plaintext across ${enc.connections} connection(s).` : "Set PRO_CREDENTIAL_KEY, restart, then migrate."}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={refreshSecurity} loading={busy === "sec-refresh"}>Re-check</Button>
              <Link href="/dashboard/profile"><Button variant="outline" size="sm">Encryption settings</Button></Link>
            </div>
          </div>

          <div className="rounded-xl bg-bg p-4">
            <div className="flex items-center gap-2">
              <StatusDot ok={locked.length === 0} />
              <h4 className="font-semibold text-text-main">Lockouts</h4>
              <Badge>{locked.length === 0 ? "None locked" : `${locked.length} locked`}</Badge>
            </div>
            {loading && !security ? (
              <p className="mt-2 text-sm text-text-muted">Loading…</p>
            ) : (security?.lockouts || []).length === 0 ? (
              <p className="mt-2 text-sm text-text-muted">No failed-login lockouts recorded.</p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {(security.lockouts || []).slice(0, 8).map((l) => (
                  <li key={l.ip} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="break-all font-mono text-xs text-text-main">{l.ip}</span>
                    <span className="text-text-muted">{l.locked ? `locked, ${fmtAgo(new Date(l.lockUntil).toISOString())} left` : `not locked, ${l.fails} fail(s)`}, level {l.lockLevel}</span>
                    {l.locked && (
                      <Button variant="secondary" size="xs" loading={busy === `unlock-${l.ip}`} onClick={() => unlockIp(l.ip)}>Unlock</Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-xl bg-bg p-4">
            <div className="flex items-center gap-2">
              <StatusDot ok />
              <h4 className="font-semibold text-text-main">Sessions</h4>
              <Badge>Epoch {security?.sessions?.tokenVersion ?? "?"}</Badge>
            </div>
            <p className="mt-2 text-sm text-text-muted">
              {security?.sessions?.currentTokenIssuedAt ? `This session started ${fmtAgo(security.sessions.currentTokenIssuedAt)}, expires ${fmtTime(security.sessions.currentTokenExpiresAt)}.` : "Stateless JWTs, one shared epoch."}
            </p>
            <div className="mt-3">
              <Button
                variant="danger" size="sm" icon="logout"
                loading={busy === "revoke"}
                onClick={() => setPending({ id: "revoke-sessions", title: "Revoke all other sessions?", message: "This invalidates every dashboard session except yours. Any other browser or device is logged out immediately. Your own session is re-issued, so you stay logged in." })}
              >
                Revoke other sessions
              </Button>
            </div>
          </div>
        </div>

        <div className="mt-4">
          <SpamRankingClient />
        </div>
      </Card>

      <Card title="Key management" subtitle="Masked values only." icon="key">
        {keys.length === 0 ? (
          <p className="text-sm text-text-muted">{loading ? "Loading…" : "No API keys yet. Create one on the Endpoint and Keys page."}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-xs uppercase tracking-wide text-text-muted">
                  <th className="py-2 pr-2">Key</th>
                  <th className="py-2 pr-2">Masked value</th>
                  <th className="py-2 pr-2">Usage</th>
                  <th className="py-2 pr-2">Status</th>
                  <th className="py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => {
                  const pct = k.quota?.limit ? Math.min(100, Math.round((Number(k.quotaUsed || 0) / Number(k.quota.limit || 1)) * 100)) : null;
                  return (
                    <tr key={k.id} className="border-b border-border-subtle/50 last:border-0">
                      <td className="max-w-[120px] break-words py-2 pr-2 font-medium text-text-main">{k.name || k.id}</td>
                      <td className="py-2 pr-2 font-mono text-xs text-text-muted">{k.keyMasked || k.last4 || "-"}</td>
                      <td className="min-w-[120px] py-2 pr-2">
                        {k.quota ? (
                          <div>
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg">
                              <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-pink-500" style={{ width: `${pct}%` }} />
                            </div>
                            <div className="mt-1 text-xs text-text-muted">{Number(k.quotaUsed || 0).toLocaleString()} / {Number(k.quota.limit || 0).toLocaleString()}{k.limitsUsage?.rpmUsed != null ? `, ${k.limitsUsage.rpmUsed} rpm` : ""}</div>
                          </div>
                        ) : (
                          <span className="text-xs text-text-muted">No quota set</span>
                        )}
                      </td>
                      <td className="py-2 pr-2">{k.isActive === false ? <Badge>Paused</Badge> : <Badge>Active</Badge>}</td>
                      <td className="py-2">
                        <div className="flex flex-wrap gap-1.5">
                          {k.isActive === false ? (
                            <Button variant="secondary" size="xs" loading={busy === `resume-${k.id}`} onClick={() => keyAction(k, "resume")}>Resume</Button>
                          ) : (
                            <Button variant="secondary" size="xs" loading={busy === `pause-${k.id}`} onClick={() => keyAction(k, "pause")}>Pause</Button>
                          )}
                          <Button variant="outline" size="xs" loading={busy === `reset-usage-${k.id}`} onClick={() => keyAction(k, "reset-usage")} disabled={!k.quota}>Reset usage</Button>
                          <Button
                            variant="outline" size="xs"
                            onClick={() => setPendingKey({ key: k, kind: "regenerate", title: "Regenerate this key?", message: `This replaces the value of "${k.name}". The new value is NOT shown anywhere. Key reads are masked-only, so update your clients right away from the Endpoint page flow. The old value stops working immediately.` })}
                          >
                            Regenerate
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="System health" subtitle="Connections, breakers, providers." icon="health_and_safety">
        {monitoring ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            <Stat label="Connections" value={`${monitoring.providers?.active ?? 0} / ${monitoring.providers?.total ?? 0}`} sub={`${monitoring.combos?.total ?? 0} combos, ${monitoring.keys?.total ?? 0} keys`} />
            <Stat label="Database" value={monitoring.health?.db === "ok" ? "OK" : "Error"} sub={`Breakers open: ${monitoring.health?.breakersOpen ?? "?"}`} />
            <Stat label="Breakers" value={health ? `${health.checks?.breakers?.open ?? 0} open, ${health.checks?.breakers?.halfOpen ?? 0} half` : "-"} sub={health ? `${health.checks?.breakers?.preTrip ?? 0} pre-trip, ${health.checks?.breakers?.total ?? 0} tracked` : ""} />
            <Stat label="Fastest provider" value={monitoring.fastest ? `${monitoring.fastest.name} (${monitoring.fastest.p50Ms}ms)` : "No data"} sub={monitoring.fastest ? `${monitoring.fastest.samples} samples (7d)` : ""} />
            <Stat label="Most used" value={monitoring.mostUsed ? `${monitoring.mostUsed.name} (${monitoring.mostUsed.requests})` : "No data"} sub={monitoring.mostUsed ? `${monitoring.mostUsed.tokens.toLocaleString()} tokens (7d)` : ""} />
            <Stat label="Proxy pools" value={`${monitoring.proxies?.activePools ?? 0} / ${monitoring.proxies?.pools ?? 0}`} sub={`${(monitoring.proxies?.totalProxies || 0).toLocaleString()} proxies`} />
            <Stat label="Most keys" value={monitoring.mostKeys ? `${monitoring.mostKeys.name} (${monitoring.mostKeys.total})` : "-"} sub="Provider holding the most keys" />
            <Stat label="Most-used key" value={monitoring.mostUsedKey?.name || "-"} sub={monitoring.mostUsedKey ? `${monitoring.mostUsedKey.requests} requests (7d)` : ""} />
          </div>
        ) : (
          <p className="text-sm text-text-muted">{loading ? "Loading…" : "Monitoring data unavailable."}</p>
        )}
      </Card>

      <Card title="Maintenance" subtitle="Each action asks first." icon="build">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {MAINTENANCE_ACTIONS.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setPending({ id: a.id, title: a.confirmTitle, message: a.confirmMessage })}
              className={`flex min-w-0 items-center gap-2 rounded-xl bg-bg px-3 py-3 text-left transition-colors hover:bg-surface-2 ${a.danger ? "border border-red-500/30" : ""}`}
            >
              <span className={`material-symbols-outlined shrink-0 text-[20px] ${a.danger ? "text-red-500" : "text-text-muted"}`}>{a.icon}</span>
              <span className="min-w-0 break-words text-sm font-semibold text-text-main">{a.title}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => setPending({ id: "restart", title: "Restart the app?", message: "This restarts 9router-pro via PM2. In-flight requests are dropped. The app should come back within seconds and this page will poll until the new BUILD_ID answers. Do not restart during a deploy." })}
            className="flex min-w-0 items-center gap-2 rounded-xl border border-red-500/30 bg-bg px-3 py-3 text-left transition-colors hover:bg-surface-2"
          >
            <span className="material-symbols-outlined shrink-0 text-[20px] text-red-500">restart_alt</span>
            <span className="min-w-0 break-words text-sm font-semibold text-text-main">Restart the app</span>
          </button>
        </div>
        {restartState?.phase ? (
          <p className="mt-3 text-sm text-text-muted">Restart: {restartLabel}{restartState?.buildId ? `, BUILD_ID ${restartState.buildId}` : ""}.</p>
        ) : null}
      </Card>

      <ConfirmModal
        isOpen={!!pending}
        onClose={() => { setPending(null); }}
        onConfirm={() => {
          if (!pending) return;
          if (pending.id === "revoke-sessions") { revokeSessions(); return; }
          if (pending.id === "restart") { doRestart(); return; }
          runMaintenance(pending.id);
        }}
        title={pending?.title || "Confirm"}
        message={pending?.message || ""}
        confirmText="Confirm"
        loading={!!busy}
      />
      <ConfirmModal
        isOpen={!!pendingKey}
        onClose={() => setPendingKey(null)}
        onConfirm={() => { if (pendingKey) keyAction(pendingKey.key, pendingKey.kind); }}
        title={pendingKey?.title || "Confirm"}
        message={pendingKey?.message || ""}
        confirmText="Confirm"
        loading={!!busy}
      />
    </div>
  );
}
