"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Card, Button, ConfirmModal, Badge } from "@/shared/components";
import { formatBytes } from "@/shared/utils/adminHelpers.js";
import SpamRankingClient from "../spam/SpamRankingClient";

const fmtTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
};

const fmtAgo = (iso) => {
  if (!iso) return "—";
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
      className={`inline-block h-2.5 w-2.5 rounded-full ${ok ? "bg-green-500" : "bg-red-500"}`}
      title={ok ? "OK" : "Attention"}
    />
  );
}

function Stat({ label, value, sub }) {
  return (
    <div className="rounded-xl bg-bg px-3 py-2.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">{label}</div>
      <div className="mt-0.5 truncate text-sm font-semibold text-text-main" title={String(value ?? "")}>{value ?? "—"}</div>
      {sub ? <div className="truncate text-[11px] text-text-muted">{sub}</div> : null}
    </div>
  );
}

// One confirm modal drives every maintenance action: the admin always
// sees exactly what will happen before anything destructive runs.
const MAINTENANCE_ACTIONS = [
  {
    id: "clear-all-caches",
    icon: "cleaning_services",
    title: "Clear all caches",
    desc: "Semantic cache, models-list cache, latency stats cache and monitoring cache.",
    confirmTitle: "Clear all caches?",
    confirmMessage: "Clears the semantic cache (all models), the models-list cache, latency stats and the monitoring cache. In-flight requests are unaffected; the next requests just rebuild the caches.",
  },
  {
    id: "clear-semantic",
    icon: "psychology",
    title: "Clear semantic cache",
    desc: "Similar-prompt cache. Returns the number of entries removed.",
    confirmTitle: "Clear semantic cache?",
    confirmMessage: "Removes every entry from the semantic (similar-prompt) cache. Cached answers will be recomputed on the next matching prompt.",
  },
  {
    id: "reset-breakers",
    icon: "power",
    title: "Reset all provider breakers",
    desc: "Clears in-memory breaker state. Warning: re-opens every provider at once.",
    danger: true,
    confirmTitle: "Reset ALL provider breakers?",
    confirmMessage: "This clears every open / half-open breaker and all per-model cooldowns at once — every provider is immediately retried. Only do this after the upstream outage is actually over, or the failures will trip the breakers again.",
  },
  {
    id: "refresh-tokens",
    icon: "autorenew",
    title: "Refresh OAuth tokens now",
    desc: "Runs the 5-minute background token-refresh tick on demand.",
    confirmTitle: "Run token refresh now?",
    confirmMessage: "Runs one background refresh tick immediately for every OAuth connection whose token is close to expiry. Safe to run any time.",
  },
  {
    id: "vacuum",
    icon: "database",
    title: "VACUUM database",
    desc: "Reclaims space in the SQLite database. Reports size before/after.",
    confirmTitle: "VACUUM the database?",
    confirmMessage: "Runs SQLite VACUUM to reclaim free space. It briefly locks the database — requests may wait a moment on a large DB.",
  },
  {
    id: "backup-now",
    icon: "backup",
    title: "Backup now",
    desc: "Creates a timestamped snapshot (same restore path as auto-backups).",
    confirmTitle: "Create a backup now?",
    confirmMessage: "Takes a timestamped snapshot of the current database export. It appears in the Settings backup list and restores through the normal import path.",
  },
  {
    id: "disk-cleanup",
    icon: "delete_sweep",
    title: "Disk cleanup",
    desc: "Old deploy tarballs (keeps current + previous) and old DB backups. Shows space freed.",
    confirmTitle: "Run disk cleanup?",
    confirmMessage: "Deletes deploy tarballs older than the newest two, DB safety backups older than the newest three, and auto-backup snapshots beyond the configured keep count. The newest backups — the restore path — are never touched.",
  },
  {
    id: "clear-logs",
    icon: "article",
    title: "Clear console log buffer",
    desc: "Truncates the dashboard-visible console log buffer.",
    confirmTitle: "Clear the console log buffer?",
    confirmMessage: "Empties the in-memory console log shown on the Console Log page. PM2's on-disk logs are untouched — use “Flush PM2 logs” for those.",
  },
  {
    id: "clear-pm2-logs",
    icon: "description",
    title: "Flush PM2 logs",
    desc: "Truncates PM2's on-disk logs (pm2 flush). PM2 hosts only.",
    confirmTitle: "Flush PM2 logs?",
    confirmMessage: "Runs `pm2 flush`, truncating the on-disk logs of every PM2 process. Only works where PM2 manages the app.",
  },
];

export default function AdminClient() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [system, setSystem] = useState(null);
  const [security, setSecurity] = useState(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(null);
  const [pending, setPending] = useState(null); // maintenance action awaiting confirm
  const [restartState, setRestartState] = useState(null); // { phase: "waiting"|"back"|"timeout", buildId }
  const restartTimer = useRef(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [sys, sec] = await Promise.all([
        fetchJson("/api/admin/system").catch((e) => { throw new Error(`System status: ${e.message}`); }),
        fetchJson("/api/admin/security").catch((e) => { throw new Error(`Security center: ${e.message}`); }),
      ]);
      setSystem(sys);
      setSecurity(sec);
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
        msg = `Semantic cache cleared — ${n ?? 0} entries removed.`;
      } else if (actionId === "clear-latency") msg = `Latency cache cleared — ${r.cleared ?? 0} cached periods dropped.`;
      else if (actionId === "clear-monitoring") msg = `Monitoring cache ${r.cleared ? "cleared" : "was already empty"}.`;
      else if (actionId === "clear-models") msg = "Models caches cleared.";
      else if (actionId === "clear-logs") msg = `Console log buffer cleared — ${r.clearedLines ?? 0} lines removed.`;
      else if (actionId === "clear-pm2-logs") msg = "PM2 logs flushed.";
      else if (actionId === "reset-breakers") msg = `Breakers reset — ${r.resetProviders ?? 0} provider(s) re-opened.`;
      else if (actionId === "vacuum") msg = `VACUUM ${r.vacuum}${r.freedBytes != null ? ` — freed ${formatBytes(r.freedBytes)}` : ""}.`;
      else if (actionId === "backup-now") msg = `Backup created — ${r?.snapshot?.id || "snapshot saved"}.`;
      else if (actionId === "disk-cleanup") msg = `Disk cleanup freed ${formatBytes(r.freedBytes || 0)} (${(r?.tarballs || []).flatMap((t) => t.removed.map((x) => x.name)).length} tarballs, ${r.removedBackupDirs?.length || 0} DB backups, ${r.removedSnapshots?.length || 0} snapshots).`;
      else if (actionId === "refresh-tokens") msg = `Token refresh tick done — ${r.dueConnections ?? 0} connection(s) were due.`;
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
      setNotice(`Restarting PM2 process "${json?.process || "9router-pro"}" — waiting for it to come back…`);
      const beforeBuild = system?.buildId;
      const startedAt = Date.now();
      restartTimer.current = setInterval(async () => {
        if (Date.now() - startedAt > 90000) {
          clearInterval(restartTimer.current);
          setRestartState({ phase: "timeout", buildId: beforeBuild });
          setNotice("Restart: no response after 90s — check the System status card or PM2 on the host.");
          setBusy(null);
          return;
        }
        try {
          const sys = await fetchJson("/api/admin/system");
          setSystem(sys);
          // A new process reports a fresh app uptime; a changed BUILD_ID
          // proves the new build is serving.
          if (sys?.buildId && beforeBuild && sys.buildId !== beforeBuild) {
            clearInterval(restartTimer.current);
            setRestartState({ phase: "back", buildId: sys.buildId });
            setNotice(`Back online — new BUILD_ID ${sys.buildId}.`);
            setBusy(null);
          } else if (sys?.appUptimeSec != null && sys.appUptimeSec < 60) {
            clearInterval(restartTimer.current);
            setRestartState({ phase: "back", buildId: sys?.buildId || null });
            setNotice(`Back online — app uptime ${sys.appUptimeSec}s${sys?.buildId ? `, BUILD_ID ${sys.buildId}` : ""}.`);
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


  const enc = security?.encryption;
  const locked = (security?.lockouts || []).filter((l) => l.locked);

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text-main">Admin</h1>
          <p className="text-sm text-text-muted">Admin-only tools — security, spam, system and maintenance. Every destructive action asks first and is written to the security log.</p>
        </div>
        <Button variant="secondary" size="sm" icon="refresh" onClick={loadAll} loading={loading}>Refresh</Button>
      </div>

      {error && (
        <Card><p className="text-sm text-red-500">{error}</p></Card>
      )}
      {notice && (
        <Card><p className="text-sm text-text-main">{notice}</p></Card>
      )}

      {/* System status — always visible */}
      <Card title="System status" subtitle="Read-only · live" icon="monitor_heart">
        {loading && !system ? (
          <p className="text-sm text-text-muted">Loading…</p>
        ) : system ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            <Stat label="Version" value={system.version ? `v${system.version}` : "—"} sub={system.buildId ? `BUILD_ID ${system.buildId.slice(0, 12)}…` : "BUILD_ID unknown"} />
            <Stat label="App uptime" value={fmtUptime(system.appUptimeSec)} sub={`Host uptime ${fmtUptime(system.uptimeSec)}`} />
            <Stat label="Memory" value={system.memory ? `${formatBytes(system.memory.totalBytes - system.memory.freeBytes)} / ${formatBytes(system.memory.totalBytes)}` : "—"} sub={system.memory ? `Process RSS ${formatBytes(system.memory.rssBytes)}` : ""} />
            <Stat label="Disk" value={system.disk ? `${formatBytes(system.disk.usedBytes)} / ${formatBytes(system.disk.totalBytes)}` : "—"} sub={system.disk ? `${formatBytes(system.disk.availBytes)} free` : "df unavailable"} />
            <Stat label="PM2" value={system.pm2?.available ? (system.pm2?.target ? `managing "${system.pm2.target.name}" (${system.pm2.target.status || "?"})` : "running, no 9router process found") : "not available on this host"} sub={system.pm2?.available ? `${(system.pm2.processes || []).length} process(es)` : "restart / pm2-flush unavailable here"} />
          </div>
        ) : (
          <p className="text-sm text-text-muted">System status unavailable.</p>
        )}
      </Card>

      {/* Security center */}
      <Card title="Security center" subtitle="Encryption, lockouts, sessions, spam / abuse" icon="shield">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl bg-bg p-4">
            <div className="flex items-center gap-2">
              <StatusDot ok={!!enc?.configured} />
              <h4 className="font-semibold text-text-main">At-rest encryption</h4>
              <Badge>{enc?.configured ? "PRO_CREDENTIAL_KEY set" : "Key NOT set"}</Badge>
            </div>
            {enc?.configured ? (
              <p className="mt-2 text-sm text-text-muted">
                Credentials encrypt on write (AES-256-GCM). {enc.encrypted} stored field(s) encrypted, {enc.plaintext} still plaintext across {enc.connections} connection(s).
                {!enc.plaintext ? "" : " Run the migration in Profile & Settings → Encryption to encrypt the rest."}
              </p>
            ) : (
              <p className="mt-2 text-sm text-red-500">
                PRO_CREDENTIAL_KEY is not configured — new credentials are stored in plaintext. Set a 64-hex-char (or base64 32-byte) key in the environment and restart, then migrate in Profile &amp; Settings → Encryption. Existing connections keep working either way.
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={refreshSecurity} loading={busy === "sec-refresh"}>Re-check</Button>
              <Link href="/dashboard/profile"><Button variant="outline" size="sm">Encryption settings</Button></Link>
            </div>
          </div>

          <div className="rounded-xl bg-bg p-4">
            <div className="flex items-center gap-2">
              <StatusDot ok={locked.length === 0} />
              <h4 className="font-semibold text-text-main">Login lockouts</h4>
              <Badge>{locked.length === 0 ? "None locked" : `${locked.length} locked`}</Badge>
            </div>
            {loading && !security ? (
              <p className="mt-2 text-sm text-text-muted">Loading…</p>
            ) : (security?.lockouts || []).length === 0 ? (
              <p className="mt-2 text-sm text-text-muted">No failed-login lockouts recorded. Lockout escalates 30s → 2m → 10m → 30m after 5 failures per IP.</p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {(security.lockouts || []).slice(0, 8).map((l) => (
                  <li key={l.ip} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-mono text-xs text-text-main">{l.ip}</span>
                    <span className="text-text-muted">{l.locked ? `locked — ${fmtAgo(new Date(l.lockUntil).toISOString())} left` : `not locked · ${l.fails} fail(s)`} · level {l.lockLevel}</span>
                    <span className="text-text-muted">last fail {fmtAgo(new Date(l.lastFailAt).toISOString())}</span>
                    {l.locked && (
                      <Button variant="secondary" size="xs" loading={busy === `unlock-${l.ip}`} onClick={() => unlockIp(l.ip)}>Unlock</Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-text-muted">The spam blacklist never blocks dashboard login, so unblocking an IP here can never lock you out.</p>
          </div>

          <div className="rounded-xl bg-bg p-4">
            <div className="flex items-center gap-2">
              <StatusDot ok />
              <h4 className="font-semibold text-text-main">Active sessions</h4>
              <Badge>Token epoch {security?.sessions?.tokenVersion ?? "?"}</Badge>
            </div>
            <p className="mt-2 text-sm text-text-muted">
              Dashboard sessions are stateless JWTs sharing one epoch — there is no per-device session list to show.
              {security?.sessions?.currentTokenIssuedAt ? ` This session started ${fmtAgo(security.sessions.currentTokenIssuedAt)} and expires ${fmtTime(security.sessions.currentTokenExpiresAt)}.` : ""}
            </p>
            <div className="mt-3">
              <Button
                variant="danger" size="sm" icon="logout"
                loading={busy === "revoke"}
                onClick={() => setPending({ id: "revoke-sessions", title: "Revoke all other sessions?", message: "This invalidates every dashboard session except yours — any other browser or device is logged out immediately. Your own session is re-issued, so you stay logged in." })}
              >
                Revoke all other sessions
              </Button>
            </div>
          </div>

        </div>

        <div className="mt-4">
          <h4 className="mb-2 font-semibold text-text-main">Spam ranking &amp; IP blacklist</h4>
          <SpamRankingClient />
        </div>
      </Card>

      {/* Maintenance */}
      <Card title="Maintenance" subtitle="Each action asks first and is written to the security log" icon="build">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {MAINTENANCE_ACTIONS.map((a) => (
            <div key={a.id} className="flex flex-col rounded-xl bg-bg p-4">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[20px] text-text-muted">{a.icon}</span>
                <h4 className="font-semibold text-text-main">{a.title}</h4>
              </div>
              <p className="mt-1 flex-1 text-sm text-text-muted">{a.desc}</p>
              <div className="mt-3">
                <Button
                  variant={a.danger ? "danger" : "secondary"} size="sm"
                  loading={busy === a.id}
                  onClick={() => setPending({ id: a.id, title: a.confirmTitle, message: a.confirmMessage })}
                >
                  Run
                </Button>
              </div>
            </div>
          ))}

          <div className="flex flex-col rounded-xl border border-red-500/30 bg-bg p-4">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[20px] text-red-500">restart_alt</span>
              <h4 className="font-semibold text-text-main">Restart the app</h4>
            </div>
            <p className="mt-1 flex-1 text-sm text-text-muted">
              Graceful PM2 restart of 9router-pro. The page waits and shows the new status (online + BUILD_ID) when it comes back.
              {system?.pm2?.available ? "" : " PM2 was not detected on this host — the button will report that instead of restarting."}
            </p>
            <div className="mt-3">
              <Button
                variant="danger" size="sm" icon="restart_alt"
                loading={busy === "restart"}
                onClick={() => setPending({ id: "restart", title: "Restart the app?", message: "This restarts 9router-pro via PM2. In-flight requests are dropped; the app should come back within seconds and this page will poll until the new BUILD_ID answers. Do not restart during a deploy." })}
              >
                Restart app
              </Button>
            </div>
          </div>
        </div>
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
    </div>
  );
}
