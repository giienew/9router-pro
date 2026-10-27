"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button, Input, Toggle } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";

export default function AutomationPage() {
  const notify = useNotificationStore();
  const [loading, setLoading] = useState(true);

  // Notifications
  const [tgEnabled, setTgEnabled] = useState(false);
  const [tgToken, setTgToken] = useState("");
  const [tgChatId, setTgChatId] = useState("");
  const [tgConfigured, setTgConfigured] = useState(false);
  const [whEnabled, setWhEnabled] = useState(false);
  const [whUrl, setWhUrl] = useState("");
  const [whSecret, setWhSecret] = useState("");
  const [testResult, setTestResult] = useState("");

  // Response cache
  const [cacheEnabled, setCacheEnabled] = useState(false);
  const [cacheTtl, setCacheTtl] = useState(3600);
  const [cacheMax, setCacheMax] = useState(1000);

  // TOTP
  const [totpEnabled, setTotpEnabled] = useState(false);
  const [totpBackupLeft, setTotpBackupLeft] = useState(0);
  const [setupData, setSetupData] = useState(null);
  const [totpCode, setTotpCode] = useState("");

  // Maintenance
  const [maintEnabled, setMaintEnabled] = useState(true);
  const [retentionDays, setRetentionDays] = useState(90);
  const [lastRun, setLastRun] = useState(null);

  const load = useCallback(async () => {
    try {
      const [nRes, sRes, tRes] = await Promise.all([
        fetch("/api/settings/notifications"),
        fetch("/api/settings"),
        fetch("/api/auth/totp"),
      ]);
      if (nRes.ok) {
        const n = await nRes.json();
        setTgEnabled(n.telegram.enabled);
        setTgChatId(n.telegram.chatId || "");
        setTgConfigured(n.telegram.configured);
        setWhEnabled(n.webhook.enabled);
        setWhUrl(n.webhook.url || "");
      }
      if (sRes.ok) {
        const s = await sRes.json();
        if (s.responseCache) {
          setCacheEnabled(s.responseCache.enabled === true);
          setCacheTtl(s.responseCache.ttlSeconds ?? 3600);
          setCacheMax(s.responseCache.maxEntries ?? 1000);
        }
        if (s.dbMaintenance) {
          setMaintEnabled(s.dbMaintenance.enabled !== false);
          setRetentionDays(s.dbMaintenance.retentionDays ?? 90);
          setLastRun(s.dbMaintenance.lastResult || null);
        }
      }
      if (tRes.ok) {
        const t = await tRes.json();
        setTotpEnabled(t.enabled === true);
        setTotpBackupLeft(t.backupCodesRemaining ?? 0);
      }
    } catch { /* keep defaults */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveNotifications = async () => {
    const res = await fetch("/api/settings/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        telegram: { enabled: tgEnabled, botToken: tgToken, chatId: tgChatId },
        webhook: { enabled: whEnabled, url: whUrl, secret: whSecret },
      }),
    });
    const data = await res.json();
    if (!res.ok) { notify.error(data.error || "Failed to save notifications"); return; }
    setTgConfigured(data.telegram.configured);
    setTgToken("");
    setWhSecret("");
    notify.success("Notification settings saved");
  };

  const testNotifications = async () => {
    const res = await fetch("/api/settings/notifications/test", { method: "POST" });
    const data = await res.json();
    setTestResult(`telegram: ${data.results?.telegram || "?"}, webhook: ${data.results?.webhook || "?"}`);
  };

  const saveCache = async () => {
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ responseCache: { enabled: cacheEnabled, ttlSeconds: Number(cacheTtl), maxEntries: Number(cacheMax) } }),
    });
    if (!res.ok) { notify.error("Failed to save response cache"); return; }
    notify.success("Response cache saved");
  };

  const saveMaintenance = async () => {
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dbMaintenance: { enabled: maintEnabled, retentionDays: Number(retentionDays) } }),
    });
    if (!res.ok) { notify.error("Failed to save maintenance settings"); return; }
    notify.success("Maintenance settings saved");
  };

  const runMaintenance = async () => {
    const res = await fetch("/api/settings/maintenance", { method: "POST" });
    const data = await res.json();
    if (!res.ok) { notify.error(data.error || "Maintenance failed"); return; }
    setLastRun(data.result);
    notify.success(`Pruned ${data.result.prunedUsage} usage + ${data.result.prunedDetails} detail rows`);
  };

  const startTotpSetup = async () => {
    const res = await fetch("/api/auth/totp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "setup" }),
    });
    const data = await res.json();
    if (!res.ok) { notify.error(data.error || "Setup failed"); return; }
    setSetupData(data);
  };

  const enableTotp = async () => {
    const res = await fetch("/api/auth/totp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "enable", code: totpCode }),
    });
    const data = await res.json();
    if (!res.ok) { notify.error(data.error || "Invalid code"); return; }
    setTotpEnabled(true);
    setSetupData(null);
    setTotpCode("");
    setTotpBackupLeft(10);
    notify.success("Two-factor authentication enabled");
  };

  const disableTotp = async () => {
    const res = await fetch("/api/auth/totp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "disable", code: totpCode }),
    });
    const data = await res.json();
    if (!res.ok) { notify.error(data.error || "Invalid code"); return; }
    setTotpEnabled(false);
    setTotpCode("");
    notify.success("Two-factor authentication disabled");
  };

  if (loading) return <p className="text-sm text-text-muted">Loading…</p>;

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <Card title="Notifications" subtitle="Telegram + webhook alerts for silent jobs (scheduled backup success/failure). Tokens are never shown back — leave a field blank to keep the stored value." icon="notifications">
        <div className="flex flex-col gap-4">
          <Toggle label="Telegram" checked={tgEnabled} onChange={setTgEnabled} description={tgConfigured ? "Bot token stored" : "No bot token stored"} />
          {tgEnabled && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input type="password" placeholder="Bot token (blank = keep stored)" value={tgToken} onChange={(e) => setTgToken(e.target.value)} />
              <Input placeholder="Chat id" value={tgChatId} onChange={(e) => setTgChatId(e.target.value)} />
            </div>
          )}
          <Toggle label="Webhook" checked={whEnabled} onChange={setWhEnabled} description="POST JSON { event, timestamp, data } + HMAC header when a secret is set" />
          {whEnabled && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input placeholder="https://… webhook URL" value={whUrl} onChange={(e) => setWhUrl(e.target.value)} />
              <Input type="password" placeholder="Secret for X-9Router-Signature (blank = keep stored)" value={whSecret} onChange={(e) => setWhSecret(e.target.value)} />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={saveNotifications}>Save</Button>
            <Button onClick={testNotifications}>Send test</Button>
            {testResult && <span className="text-xs text-text-muted">{testResult}</span>}
          </div>
        </div>
      </Card>

      <Card title="Response Cache" subtitle="Exact replays for non-streaming chat completions only. Tool calls are never cached. Off by default." icon="cached">
        <div className="flex flex-col gap-4">
          <Toggle label="Enable response cache" checked={cacheEnabled} onChange={setCacheEnabled} />
          {cacheEnabled && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <label className="flex flex-col gap-1 text-xs text-text-muted">TTL (seconds)
                <Input type="number" value={cacheTtl} onChange={(e) => setCacheTtl(e.target.value)} />
              </label>
              <label className="flex flex-col gap-1 text-xs text-text-muted">Max entries
                <Input type="number" value={cacheMax} onChange={(e) => setCacheMax(e.target.value)} />
              </label>
            </div>
          )}
          <div><Button variant="primary" onClick={saveCache}>Save</Button></div>
        </div>
      </Card>

      <Card title="Two-Factor Authentication" subtitle="TOTP for dashboard password login. Setup shows the secret + backup codes once — save them before enabling." icon="shield">
        <div className="flex flex-col gap-4">
          <p className="text-sm">Status: <b>{totpEnabled ? `Enabled (${totpBackupLeft} backup codes left)` : "Disabled"}</b></p>
          {!totpEnabled && !setupData && <div><Button variant="primary" onClick={startTotpSetup}>Start setup</Button></div>}
          {!totpEnabled && setupData && (
            <div className="flex flex-col gap-2 text-sm">
              <p>Add this secret to your authenticator app (or open the URL):</p>
              <code className="break-all rounded bg-sidebar px-2 py-1 text-xs">{setupData.secret}</code>
              <code className="break-all rounded bg-sidebar px-2 py-1 text-xs">{setupData.otpauthUrl}</code>
              <p>Backup codes — store them somewhere safe, they are shown only here:</p>
              <div className="grid grid-cols-2 gap-1 font-mono text-xs">
                {setupData.backupCodes.map((c) => <span key={c}>{c}</span>)}
              </div>
              <div className="flex gap-2">
                <Input placeholder="6-digit code from the app" value={totpCode} onChange={(e) => setTotpCode(e.target.value)} />
                <Button variant="primary" onClick={enableTotp}>Enable</Button>
              </div>
            </div>
          )}
          {totpEnabled && (
            <div className="flex gap-2">
              <Input placeholder="Current code or backup code to disable" value={totpCode} onChange={(e) => setTotpCode(e.target.value)} />
              <Button onClick={disableTotp}>Disable</Button>
            </div>
          )}
        </div>
      </Card>

      <Card title="Database Maintenance" subtitle="Daily: prune per-request history older than retention, drop expired cache rows, VACUUM. Daily rollups are kept forever." icon="cleaning_services">
        <div className="flex flex-col gap-4">
          <Toggle label="Enable scheduled maintenance" checked={maintEnabled} onChange={setMaintEnabled} />
          <label className="flex max-w-xs flex-col gap-1 text-xs text-text-muted">Retention (days)
            <Input type="number" value={retentionDays} onChange={(e) => setRetentionDays(e.target.value)} />
          </label>
          {lastRun && (
            <p className="text-xs text-text-muted">
              Last run {lastRun.ranAt}: pruned {lastRun.prunedUsage} usage, {lastRun.prunedDetails} details, {lastRun.prunedCache} cache rows · vacuum {lastRun.vacuum}
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="primary" onClick={saveMaintenance}>Save</Button>
            <Button onClick={runMaintenance}>Run now</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
