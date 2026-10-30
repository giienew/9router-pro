"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import PropTypes from "prop-types";
import { Card, Button, Input, Modal, CardSkeleton, Toggle, ConfirmModal, ModelSelectModal, Tooltip } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import {
  TUNNEL_BENEFITS,
  TUNNEL_PING_INTERVAL_MS,
  TUNNEL_PING_MAX_MS,
  STATUS_POLL_FAST_MS,
  REACHABLE_MISS_THRESHOLD,
  CLIENT_PING_FAST_MS,
} from "./endpointConstants";
import { clientPingUrl, clientPingAny } from "./endpointPing";
import useSettingsStore from "@/store/settingsStore";
import { useNotificationStore } from "@/store/notificationStore";
import EndpointRow from "./components/EndpointRow";
import StatusAlert from "./components/StatusAlert";
import SecurityWarning from "./components/SecurityWarning";
import KeyAccessControls from "./components/KeyAccessControls";
import FirstRequestSnippet from "./components/FirstRequestSnippet";


export default function APIPageClient({ machineId }) {
  const [keys, setKeys] = useState([]);
  const notify = useNotificationStore();
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  // 9Router Pro: optional settings applied to the key right at creation time,
  // so a reseller key is fully configured in one step (editable later in the
  // key's Settings panel).
  const emptyKeyDraft = () => ({
    restricted: false,
    allow: [],
    quotaEnabled: false,
    quotaLimit: "100000",
    quotaWindow: 24,
    quotaCostLimit: "",
    expiresAt: "",
    limits: { rpm: "", tpm: "", rph: "", rpd: "", maxConcurrent: "" },
  });
  const [newKeyDraft, setNewKeyDraft] = useState(emptyKeyDraft);
  const [createPickerOpen, setCreatePickerOpen] = useState(false);
  const [createPickerProviders, setCreatePickerProviders] = useState([]);
  const [createPickerAliases, setCreatePickerAliases] = useState({});
  const [createdKey, setCreatedKey] = useState(null);
  const [createdKeyName, setCreatedKeyName] = useState("");
  const [confirmState, setConfirmState] = useState(null);
  // R11 bulk key edit: checkbox selection + one modal for the selection.
  const [selectedKeyIds, setSelectedKeyIds] = useState([]);
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkDraft, setBulkDraft] = useState({ expiresAt: "", clearExpiry: false, quotaLimit: "", quotaWindow: 24, clearQuota: false, tpm: "", clearTpm: false, allowText: "", active: "" });

  const toggleKeySelect = (id) => setSelectedKeyIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const applyBulkEdit = async () => {
    const updates = {};
    if (bulkDraft.clearExpiry) updates.expiresAt = null;
    else if (bulkDraft.expiresAt) updates.expiresAt = `${bulkDraft.expiresAt}T23:59:59.999Z`;
    if (bulkDraft.clearQuota) updates.quota = null;
    else if (bulkDraft.quotaLimit) updates.quota = { enabled: true, limit: parseInt(bulkDraft.quotaLimit, 10), windowHours: Number(bulkDraft.quotaWindow) || 24 };
    if (bulkDraft.clearTpm) updates.limits = null;
    else if (bulkDraft.tpm) updates.limits = { tpm: parseInt(bulkDraft.tpm, 10) };
    if (bulkDraft.allowText.trim()) updates.access = { restricted: true, allow: bulkDraft.allowText.split(",").map((s) => s.trim()).filter(Boolean) };
    if (bulkDraft.active === "pause") updates.isActive = false;
    else if (bulkDraft.active === "resume") updates.isActive = true;
    if (!Object.keys(updates).length) { notify.error("Nothing to change — fill at least one bulk field."); return; }
    setBulkBusy(true);
    try {
      const res = await fetch("/api/keys", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: selectedKeyIds, updates }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Bulk edit failed");
      notify.success(`Updated ${data.updated.length} key(s)${data.failed.length ? `, ${data.failed.length} failed` : ""}.`);
      setShowBulkModal(false);
      setSelectedKeyIds([]);
      await fetchData();
    } catch (e) {
      notify.error(e.message);
    }
    setBulkBusy(false);
  };

  const [requireApiKey, setRequireApiKey] = useState(false);
  const [requireLogin, setRequireLogin] = useState(true);
  const [hasPassword, setHasPassword] = useState(true);
 const [tunnelDashboardAccess, setTunnelDashboardAccess] = useState(false);

 // Cloudflare Tunnel state
  const [tunnelChecking, setTunnelChecking] = useState(true);
  const [tunnelEnabled, setTunnelEnabled] = useState(false);
  const [tunnelReachable, setTunnelReachable] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState("");
  const [tunnelPublicUrl, setTunnelPublicUrl] = useState("");
  const [tunnelLoading, setTunnelLoading] = useState(false);
  const [tunnelProgress, setTunnelProgress] = useState("");
  const [tunnelStatus, setTunnelStatus] = useState(null);
  const [showEnableTunnelModal, setShowEnableTunnelModal] = useState(false);
  const [showDisableTunnelModal, setShowDisableTunnelModal] = useState(false);

  // Tailscale state
  const [tsEnabled, setTsEnabled] = useState(false);
  const [tsReachable, setTsReachable] = useState(false);
  const [tsUrl, setTsUrl] = useState("");
  const [tsLoading, setTsLoading] = useState(false);
  const [tsProgress, setTsProgress] = useState("");
  const [tsStatus, setTsStatus] = useState(null);
  const [tsAuthUrl, setTsAuthUrl] = useState("");
  const [tsAuthLabel, setTsAuthLabel] = useState("");
  const [tsInstalled, setTsInstalled] = useState(null); // null=checking, true/false
  const [tsInstalling, setTsInstalling] = useState(false);
  const [tsInstallLog, setTsInstallLog] = useState([]);
  const [tsSudoPassword, setTsSudoPassword] = useState("");
  const [tsConnecting, setTsConnecting] = useState(false);
  const [showTsModal, setShowTsModal] = useState(false);
  const [showDisableTsModal, setShowDisableTsModal] = useState(false);
  const tsLogRef = useRef(null);

  // Debounce reachable=false: server may briefly return false during background refresh.
  // Only flip UI to "reconnecting" after N consecutive misses to avoid spinner flicker.
  const tunnelMissRef = useRef(0);
  const tsMissRef = useRef(0);
  // Browser-side reachable cache (independent of backend DNS quirks)
  const tunnelClientReachableRef = useRef(false);
  const tsClientReachableRef = useRef(false);
  // Track whether reachable=true was ever observed in this session.
  // Distinguishes "Checking..." (initial cold cache) from "Reconnecting..." (lost connection).
  const tunnelEverReachableRef = useRef(false);
  const tsEverReachableRef = useRef(false);
  const [tunnelEverReachable, setTunnelEverReachable] = useState(false);
  const [tsEverReachable, setTsEverReachable] = useState(false);

  // API key visibility toggle state
  const [visibleKeys, setVisibleKeys] = useState(new Set());

  // Client-side local/remote detection (UI hint only, not a security gate)
  const [isRemoteHost, setIsRemoteHost] = useState(false);
  useEffect(() => {
    if (typeof window !== "undefined")
      setIsRemoteHost(!["localhost", "127.0.0.1", "::1"].includes(window.location.hostname));
  }, []);

  const { copied, copy } = useCopyToClipboard();

  // Security gate: block remote exposure while dashboard uses default password or login is off.
  const isLoginUnsafe = !requireLogin || !hasPassword;
  const unsafeReason = !requireLogin
    ? "Enable \"Require login\" and set a custom password before activating the tunnel."
    : "Change the default dashboard password before activating the tunnel.";

  // Auto-scroll install log
  useEffect(() => {
    if (tsLogRef.current) tsLogRef.current.scrollTop = tsLogRef.current.scrollHeight;
  }, [tsInstallLog]);

  useEffect(() => {
    fetchData();
    loadSettings();
  }, []);

  // Status poll: only while degraded (not yet reachable). Stop once healthy to avoid spam.
  // Visibility re-check: refresh once when tab becomes visible.
  useEffect(() => {
    const anyEnabled = tunnelEnabled || tsEnabled;
    if (!anyEnabled) return;
    const tunnelHealthy = !tunnelEnabled || tunnelReachable;
    const tsHealthy = !tsEnabled || tsReachable;
    const allHealthy = tunnelHealthy && tsHealthy;
    const onVisible = () => { if (!document.hidden) syncTunnelStatus(); };
    document.addEventListener("visibilitychange", onVisible);
    if (allHealthy) return () => document.removeEventListener("visibilitychange", onVisible);
    const timer = setInterval(() => { if (!document.hidden) syncTunnelStatus(); }, STATUS_POLL_FAST_MS);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tunnelEnabled, tsEnabled, tunnelReachable, tsReachable]);

  // Browser-side periodic ping: probes tunnel/tailscale URLs directly so UI stays
  // "reachable" even when backend DNS (1.1.1.1) hiccups on *.ts.net or *.trycloudflare.com.
  // Adaptive: slow when healthy, fast when degraded; pause when tab hidden.
  useEffect(() => {
    const probeBoth = async () => {
      if (document.hidden) return;
      if (tunnelEnabled && (tunnelUrl || tunnelPublicUrl)) {
        const ok = await clientPingAny(tunnelPublicUrl, tunnelUrl);
        tunnelClientReachableRef.current = ok;
        if (ok) { tunnelMissRef.current = 0; setTunnelReachable(true); if (!tunnelEverReachableRef.current) { tunnelEverReachableRef.current = true; setTunnelEverReachable(true); } }
        else { tunnelMissRef.current += 1; if (tunnelMissRef.current >= REACHABLE_MISS_THRESHOLD) setTunnelReachable(false); }
      } else {
        tunnelClientReachableRef.current = false;
      }
      if (tsEnabled && tsUrl) {
        const ok = await clientPingUrl(tsUrl);
        tsClientReachableRef.current = ok;
        if (ok) { tsMissRef.current = 0; setTsReachable(true); if (!tsEverReachableRef.current) { tsEverReachableRef.current = true; setTsEverReachable(true); } }
        else { tsMissRef.current += 1; if (tsMissRef.current >= REACHABLE_MISS_THRESHOLD) setTsReachable(false); }
      } else {
        tsClientReachableRef.current = false;
      }
    };
    const anyEnabled = (tunnelEnabled && (tunnelUrl || tunnelPublicUrl)) || (tsEnabled && tsUrl);
    if (!anyEnabled) return;
    probeBoth();
    const tunnelHealthy = !tunnelEnabled || tunnelReachable;
    const tsHealthy = !tsEnabled || tsReachable;
    if (tunnelHealthy && tsHealthy) return;
    const id = setInterval(probeBoth, CLIENT_PING_FAST_MS);
    return () => clearInterval(id);
  }, [tunnelEnabled, tunnelUrl, tunnelPublicUrl, tsEnabled, tsUrl, tunnelReachable, tsReachable]);

  // Client-side reachable only (server no longer probes; watchdog handles backend health).
  // Miss-debounce: only flip to false after N consecutive misses.
  const updateReachable = useCallback((_unused, clientRef, missRef, setter, everRef, everSetter) => {
    const reachable = clientRef.current;
    if (reachable) {
      missRef.current = 0;
      setter(true);
      if (!everRef.current) {
        everRef.current = true;
        everSetter(true);
      }
    } else {
      missRef.current += 1;
      if (missRef.current >= REACHABLE_MISS_THRESHOLD) setter(false);
    }
  }, []);

  // Trust user intent (settingsEnabled): UI stays "enabled" while watchdog restarts process
  const syncTunnelStatus = async () => {
    try {
      const statusRes = await fetch("/api/tunnel/status", { cache: "no-store" });
      if (!statusRes.ok) return;
      const data = await statusRes.json();
      const tEnabled = data.tunnel?.settingsEnabled ?? data.tunnel?.enabled ?? false;
      const tUrl = data.tunnel?.tunnelUrl || "";
      setTunnelUrl(tUrl);
      setTunnelPublicUrl(data.tunnel?.publicUrl || "");
      setTunnelEnabled(tEnabled);
      updateReachable(null, tunnelClientReachableRef, tunnelMissRef, setTunnelReachable, tunnelEverReachableRef, setTunnelEverReachable);

      const tsEn = data.tailscale?.settingsEnabled ?? data.tailscale?.enabled ?? false;
      const tsUrlVal = data.tailscale?.tunnelUrl || "";
      setTsUrl(tsUrlVal);
      setTsEnabled(tsEn);
      updateReachable(null, tsClientReachableRef, tsMissRef, setTsReachable, tsEverReachableRef, setTsEverReachable);
    } catch { /* ignore poll errors */ }
  };

  const loadSettings = async () => {
    setTunnelChecking(true);
    try {
      const [settingsData, statusRes] = await Promise.all([
        useSettingsStore.getState().fetchSettings(),
        fetch("/api/tunnel/status", { cache: "no-store" })
      ]);
      if (settingsData) {
        setRequireApiKey(settingsData.requireApiKey || false);
        setRequireLogin(settingsData.requireLogin !== false);
        setHasPassword(settingsData.hasPassword || false);
        setTunnelDashboardAccess(settingsData.tunnelDashboardAccess || false);
      }
      if (statusRes.ok) {
        const data = await statusRes.json();
        const tEnabled = data.tunnel?.settingsEnabled ?? data.tunnel?.enabled ?? false;
        const tUrl = data.tunnel?.tunnelUrl || "";
        setTunnelUrl(tUrl);
        setTunnelPublicUrl(data.tunnel?.publicUrl || "");
        setTunnelEnabled(tEnabled);
        updateReachable(null, tunnelClientReachableRef, tunnelMissRef, setTunnelReachable, tunnelEverReachableRef, setTunnelEverReachable);

        const tsEn = data.tailscale?.settingsEnabled ?? data.tailscale?.enabled ?? false;
        const tsUrlVal = data.tailscale?.tunnelUrl || "";
        setTsUrl(tsUrlVal);
        setTsEnabled(tsEn);
        updateReachable(null, tsClientReachableRef, tsMissRef, setTsReachable, tsEverReachableRef, setTsEverReachable);
      }
    } catch (error) {
      console.log("Error loading settings:", error);
    } finally {
      setTunnelChecking(false);
    }
  };

  const handleTunnelDashboardAccess = async (value) => {
    try {
      const updated = await useSettingsStore.getState().patchSettings({ tunnelDashboardAccess: value });
      if (updated) setTunnelDashboardAccess(value);
    } catch (error) {
      console.log("Error updating tunnelDashboardAccess:", error);
    }
  };

  const handleRequireApiKey = async (value) => {
    try {
      const updated = await useSettingsStore.getState().patchSettings({ requireApiKey: value });
      if (updated) setRequireApiKey(value);
    } catch (error) {
      console.log("Error updating requireApiKey:", error);
    }
  };

  const fetchData = async () => {
    try {
      const fetchKeys = async () => {
        const res = await fetch("/api/keys");
        if (!res.ok) return [];
        const data = await res.json();
        return data.keys || [];
      };

      let existing = await fetchKeys();
      // Auto-provision a default key for first-time users so the endpoint works out of the box.
      if (existing.length === 0) {
        try {
          const createRes = await fetch("/api/keys", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Default Key" }),
          });
          if (createRes.ok) existing = await fetchKeys();
        } catch { /* fall through to empty render */ }
      }
      setKeys(existing);
    } catch (error) {
      console.log("Error fetching data:", error);
    } finally {
      setLoading(false);
    }
  };

  // u2500u2500u2500 Cloudflare Tunnel handlers
  // Ping tunnel health until reachable. Race multiple URLs (shortlink + direct) — 1 OK is enough.
  const pingTunnelHealth = async (...urls) => {
    setTunnelLoading(true);
    setTunnelProgress("Waiting for tunnel ready...");
    const targets = urls.filter(Boolean).map((u) => `${u}/api/health`);
    const start = Date.now();
    while (Date.now() - start < TUNNEL_PING_MAX_MS) {
      await new Promise((r) => setTimeout(r, TUNNEL_PING_INTERVAL_MS));
      const ok = await Promise.any(targets.map(async (h) => {
        const p = await fetch(h, { mode: "cors", cache: "no-store" });
        if (p.ok) return true;
        throw new Error("not ready");
      })).catch(() => false);
      if (ok) {
        setTunnelEnabled(true);
        setTunnelLoading(false);
        setTunnelProgress("");
        return true;
      }
      // Every 5 pings (~10s), check if backend process still alive
      if ((Date.now() - start) % 10000 < TUNNEL_PING_INTERVAL_MS) {
        try {
          const statusRes = await fetch("/api/tunnel/status");
          if (statusRes.ok) {
            const status = await statusRes.json();
            if (!status.tunnel?.enabled) {
              setTunnelStatus({ type: "error", message: "Tunnel process stopped unexpectedly." });
              setTunnelLoading(false);
              setTunnelProgress("");
              return false;
            }
          }
        } catch { /* ignore */ }
      }
    }
    setTunnelStatus({ type: "error", message: "Tunnel created but not reachable. Please try again." });
    setTunnelLoading(false);
    setTunnelProgress("");
    return false;
  };

  const handleEnableTunnel = async () => {
    setShowEnableTunnelModal(false);
    setTunnelLoading(true);
    setTunnelStatus(null);
    setTunnelProgress("Creating tunnel...");

    // Poll download progress while enable request is pending
    let polling = true;
    const pollProgress = async () => {
      while (polling) {
        try {
          const r = await fetch("/api/tunnel/status");
          if (r.ok) {
            const s = await r.json();
            if (s.download?.downloading) {
              setTunnelProgress(`Downloading cloudflared... ${s.download.progress}%`);
            } else if (polling) {
              setTunnelProgress("Creating tunnel...");
            }
          }
        } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 1000));
      }
    };
    pollProgress();

    try {
      const res = await fetch("/api/tunnel/enable", { method: "POST" });
      polling = false;
      const data = await res.json();
      if (!res.ok) {
        setTunnelStatus({ type: "error", message: data.error || "Failed to enable tunnel" });
        return;
      }

      const url = data.tunnelUrl;
      if (!url) {
        setTunnelStatus({ type: "error", message: "No tunnel URL returned" });
        return;
      }

      setTunnelUrl(url);
      setTunnelPublicUrl(data.publicUrl || "");
      await pingTunnelHealth(data.publicUrl, url);
    } catch (error) {
      setTunnelStatus({ type: "error", message: error.message });
    } finally {
      polling = false;
      setTunnelLoading(false);
      setTunnelProgress("");
    }
  };

  const handleDisableTunnel = async () => {
    setTunnelLoading(true);
    setTunnelStatus(null);
    try {
      const res = await fetch("/api/tunnel/disable", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setTunnelEnabled(false);
        setTunnelUrl("");
        setShowDisableTunnelModal(false);
        setTunnelStatus({ type: "success", message: "Tunnel disabled" });
      } else {
        setTunnelStatus({ type: "error", message: data.error || "Failed to disable tunnel" });
      }
    } catch (error) {
      setTunnelStatus({ type: "error", message: error.message });
    } finally {
      setTunnelLoading(false);
    }
  };

  // u2500u2500u2500 Tailscale handlers
  const checkTailscaleInstalled = async () => {
    setTsInstalled(null);
    try {
      const res = await fetch("/api/tunnel/tailscale-check");
      if (res.ok) {
        const data = await res.json();
        setTsInstalled(data.installed);
        return data;
      }
    } catch { /* ignore */ }
    setTsInstalled(false);
    return { installed: false };
  };

  const handleInstallTailscale = async () => {
    setTsInstalling(true);
    setTsStatus(null);
    setTsInstallLog([]);
    try {
      const res = await fetch("/api/tunnel/tailscale-install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sudoPassword: tsSudoPassword }),
      });
      setTsSudoPassword("");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        for (const part of parts) {
          const lines = part.split("\n");
          let event = "progress";
          let data = null;
          for (const line of lines) {
            if (line.startsWith("event: ")) event = line.slice(7).trim();
            if (line.startsWith("data: ")) {
              try { data = JSON.parse(line.slice(6)); } catch { /* skip */ }
            }
          }
          if (!data) continue;
          if (event === "progress") {
            setTsInstallLog((prev) => [...prev.slice(-50), data.message]);
          } else if (event === "done") {
            setTsInstalled(true);
            setTsInstalling(false);
            setShowTsModal(false);
            handleConnectTailscale();
            return;
          } else if (event === "error") {
            setTsStatus({ type: "error", message: data.error || "Install failed" });
          }
        }
      }
    } catch (e) {
      setTsStatus({ type: "error", message: e.message });
    } finally {
      setTsInstalling(false);
    }
  };

  // Ping Tailscale health until reachable
  const pingTsHealth = async (url) => {
    setTsProgress("Waiting for Tailscale ready...");
    const healthUrl = `${url}/api/health`;
    const start = Date.now();
    while (Date.now() - start < TUNNEL_PING_MAX_MS) {
      await new Promise((r) => setTimeout(r, TUNNEL_PING_INTERVAL_MS));
      try {
        const ping = await fetch(healthUrl, { mode: "no-cors", cache: "no-store" });
        if (ping.ok || ping.type === "opaque") return true;
      } catch { /* not ready yet */ }
    }
    return false;
  };

  // Show inline login button instead of auto-opening popup (browsers block popups
  // opened after async work because the user gesture is lost).
  const requestUserAuth = (url, label) => {
    setTsAuthUrl(url);
    setTsAuthLabel(label);
  };

  const clearUserAuth = () => {
    setTsAuthUrl("");
    setTsAuthLabel("");
  };

  const handleConnectTailscale = async () => {
    setShowTsModal(false);
    setTsConnecting(true);
    setTsLoading(true);
    setTsStatus(null);
    setTsProgress("Connecting...");
    clearUserAuth();
    try {
      const res = await fetch("/api/tunnel/tailscale-enable", { method: "POST" });
      const data = await res.json();

      if (res.ok && data.success) {
        setTsUrl(data.tunnelUrl || "");
        const reachable = await pingTsHealth(data.tunnelUrl);
        setTsEnabled(true);
        setTsStatus(reachable ? null : { type: "warning", message: "Connected but not reachable yet." });
        return;
      }

      if (data.needsLogin && data.authUrl) {
        requestUserAuth(data.authUrl, "Open Login Page");
        setTsProgress("Login required — click \"Open Login Page\" to continue");
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          try {
            const r2 = await fetch("/api/tunnel/tailscale-check");
            if (r2.ok) {
              const check = await r2.json();
              if (check.loggedIn) {
                clearUserAuth();
                setTsProgress("Starting funnel...");
                const res2 = await fetch("/api/tunnel/tailscale-enable", { method: "POST" });
                const data2 = await res2.json();
                if (res2.ok && data2.success) {
                  setTsUrl(data2.tunnelUrl || "");
                  const ok2 = await pingTsHealth(data2.tunnelUrl);
                  setTsEnabled(true);
                  setTsStatus(ok2 ? null : { type: "warning", message: "Connected but not reachable yet." });
                } else if (data2.funnelNotEnabled && data2.enableUrl) {
                  await pollFunnelEnable(data2.enableUrl);
                } else {
                  setTsStatus({ type: "error", message: data2.error || "Failed to start funnel" });
                }
                return;
              }
            }
          } catch { /* retry */ }
        }
        clearUserAuth();
        setTsStatus({ type: "error", message: "Login timed out. Please try again." });
        return;
      }

      if (data.funnelNotEnabled && data.enableUrl) {
        await pollFunnelEnable(data.enableUrl);
        return;
      }

      setTsStatus({ type: "error", message: data.error || "Failed to connect" });
    } catch (error) {
      setTsStatus({ type: "error", message: error.message });
    } finally {
      setTsLoading(false);
      setTsConnecting(false);
      setTsProgress("");
      clearUserAuth();
    }
  };

  const pollFunnelEnable = async (enableUrl) => {
    requestUserAuth(enableUrl, "Open Funnel Settings");
    setTsProgress("Click \"Open Funnel Settings\" to enable Funnel...");
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const res = await fetch("/api/tunnel/tailscale-enable", { method: "POST" });
        const data = await res.json();
        if (res.ok && data.success) {
          clearUserAuth();
          setTsUrl(data.tunnelUrl || "");
          const ok3 = await pingTsHealth(data.tunnelUrl);
          setTsEnabled(true);
          setTsStatus(ok3 ? null : { type: "warning", message: "Connected but not reachable yet." });
          return;
        }
        if (data.funnelNotEnabled) continue;
        if (data.error) {
          clearUserAuth();
          setTsStatus({ type: "error", message: data.error });
          return;
        }
      } catch { /* retry */ }
    }
    clearUserAuth();
    setTsStatus({ type: "error", message: "Timed out waiting for Funnel to be enabled." });
  };

  const handleDisableTailscale = async () => {
    setTsLoading(true);
    setTsStatus(null);
    try {
      const res = await fetch("/api/tunnel/tailscale-disable", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setTsEnabled(false);
        setTsUrl("");
        setShowDisableTsModal(false);
        setTsStatus({ type: "success", message: "Tailscale disabled" });
      } else {
        setTsStatus({ type: "error", message: data.error || "Failed to disable Tailscale" });
      }
    } catch (e) {
      setTsStatus({ type: "error", message: e.message });
    } finally {
      setTsLoading(false);
    }
  };

  const handleOpenTsModal = async () => {
    setTsStatus(null);
    setTsInstallLog([]);
    const data = await checkTailscaleInstalled();
    if (data?.installed && data?.hasCachedPassword) {
      handleConnectTailscale();
    } else {
      setShowTsModal(true);
    }
  };

  const closeAddModal = () => {
    setShowAddModal(false);
    setNewKeyName("");
    setNewKeyDraft(emptyKeyDraft());
    setCreatePickerOpen(false);
  };

  const openCreatePicker = async () => {
    setCreatePickerOpen(true);
    // Same sources the combo editor feeds the picker with.
    try {
      const [providersRes, aliasRes] = await Promise.all([fetch("/api/providers?lite=1"), fetch("/api/models/alias")]);
      if (providersRes.ok) setCreatePickerProviders((await providersRes.json()).connections || []);
      if (aliasRes.ok) setCreatePickerAliases((await aliasRes.json()).aliases || {});
    } catch (error) {
      console.log("Error loading picker data:", error);
    }
  };

  const handleCreateKey = async () => {
    if (!newKeyName.trim()) return;

    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newKeyName }),
      });
      const data = await res.json();

      if (res.ok) {
        // Apply the optional settings picked in the create dialog.
        const id = data.key?.id;
        if (id) {
          if (newKeyDraft.restricted) {
            await handleUpdateKeyAccess(id, { restricted: true, allow: newKeyDraft.allow });
          }
          if (newKeyDraft.quotaEnabled) {
            const limit = parseInt(newKeyDraft.quotaLimit, 10);
            if (limit > 0) {
              const costLimit = parseFloat(newKeyDraft.quotaCostLimit);
              await handleUpdateKeyQuota(id, {
                enabled: true, limit, windowHours: newKeyDraft.quotaWindow,
                ...(Number.isFinite(costLimit) && costLimit > 0 ? { costLimit } : {}),
              });
            }
          }
          if (newKeyDraft.expiresAt) {
            await handleUpdateKeyExpiry(id, `${newKeyDraft.expiresAt}T23:59:59.999Z`);
          }
          const limits = {};
          let hasLimits = false;
          for (const f of ["rpm", "tpm", "rph", "rpd", "maxConcurrent"]) {
            const v = parseInt(newKeyDraft.limits[f], 10);
            limits[f] = Number.isFinite(v) && v > 0 ? v : null;
            if (limits[f]) hasLimits = true;
          }
          if (hasLimits) await handleUpdateKeyLimits(id, limits);
        }
        setCreatedKey(data.key);
        setCreatedKeyName(newKeyName);
        await fetchData();
        closeAddModal();
      } else {
        notify.error(data.error || "Failed to create API key");
      }
    } catch (error) {
      console.log("Error creating key:", error);
      notify.error(error?.message || "Failed to create API key");
    }
  };

  const handleDeleteKey = async (id) => {
    setConfirmState({
      title: "Delete API Key",
      message: "Delete this API key?",
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/keys/${id}`, { method: "DELETE" });
          if (res.ok) {
            setKeys(keys.filter((k) => k.id !== id));
            setVisibleKeys(prev => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          }
        } catch (error) {
          console.log("Error deleting key:", error);
        }
      }
    });
  };

  const handleToggleKey = async (id, isActive) => {
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (res.ok) {
        setKeys(prev => prev.map(k => k.id === id ? { ...k, isActive } : k));
      }
    } catch (error) {
      console.log("Error toggling key:", error);
    }
  };

  // Save a key's access (restricted flag + allow list).
  const handleUpdateKeyAccess = async (id, access) => {
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.key) {
        setKeys(prev => prev.map(k => k.id === id ? { ...k, access: data.key.access } : k));
      } else {
        console.log("Error updating key access:", data.error || res.status);
      }
    } catch (error) {
      console.log("Error updating key access:", error);
    }
  };

  // 9Router Pro: save a key's rate limits (null clears them).
  const handleUpdateKeyLimits = async (id, limits) => {
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limits }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.key) {
        setKeys(prev => prev.map(k => k.id === id ? { ...k, limits: data.key.limits, limitsUsage: data.key.limitsUsage } : k));
      } else {
        console.log("Error updating key limits:", data.error || res.status);
      }
    } catch (error) {
      console.log("Error updating key limits:", error);
    }
  };

  // 9Router Pro: save a key's expiry (null clears it).
  const handleUpdateKeyExpiry = async (id, expiresAt) => {
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiresAt }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.key) {
        setKeys(prev => prev.map(k => k.id === id ? { ...k, expiresAt: data.key.expiresAt } : k));
      } else {
        notify.error(data.error || "Failed to update key expiry");
      }
    } catch (error) {
      console.log("Error updating key expiry:", error);
    }
  };

  // 9Router Pro: save a key's token quota (null clears it).
  const handleUpdateKeyQuota = async (id, quota) => {
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quota }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.key) {
        setKeys(prev => prev.map(k => k.id === id ? { ...k, quota: data.key.quota, quotaUsed: data.key.quotaUsed } : k));
      } else {
        console.log("Error updating key quota:", data.error || res.status);
      }
    } catch (error) {
      console.log("Error updating key quota:", error);
    }
  };

  const maskKey = (fullKey) => {
    if (!fullKey || fullKey.length <= 10) return fullKey || "";
    return fullKey.slice(0, 6) + "•".repeat(fullKey.length - 10) + fullKey.slice(-4);
  };

  const toggleKeyVisibility = (keyId) => {
    setVisibleKeys(prev => {
      const next = new Set(prev);
      if (next.has(keyId)) next.delete(keyId);
      else next.add(keyId);
      return next;
    });
  };

  const [baseUrl, setBaseUrl] = useState("/v1");

  // Hydration fix: Only access window on client side
  useEffect(() => {
    if (typeof window !== "undefined") {
      setBaseUrl(`${window.location.origin}/v1`);
    }
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const currentEndpoint = baseUrl;

  return (
    <div className="flex flex-col gap-8">
      {/* Endpoint Card */}
      <Card>
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">api</span>
          API Endpoint
        </h2>

        {/* Endpoint rows */}
        <div className="flex flex-col gap-2">
          {/* Local */}
          <EndpointRow
            label="Local"
            url={currentEndpoint}
            copyId="local_url"
            copied={copied}
            onCopy={copy}
          />
          {/* Cloudflare Tunnel */}
          <div className="flex items-center gap-2">
            <span className={`text-xs font-mono px-1.5 py-0.5 rounded shrink-0 min-w-[88px] text-center ${
              tunnelEnabled ? "bg-primary/10 text-primary" : "bg-surface-2 text-text-muted"
            }`}>Tunnel</span>
            {tunnelEnabled && !tunnelLoading && tunnelReachable ? (
              <>
                <Input value={`${tunnelPublicUrl || tunnelUrl}/v1`} readOnly className="flex-1 font-mono text-sm" />
                <button
                  onClick={() => copy(`${tunnelPublicUrl || tunnelUrl}/v1`, "tunnel_url")}
                  className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary transition-colors shrink-0"
                >
                  <span className="material-symbols-outlined text-[18px]">{copied === "tunnel_url" ? "check" : "content_copy"}</span>
                </button>
                <button
                  onClick={() => setShowDisableTunnelModal(true)}
                  className="p-2 hover:bg-red-500/10 rounded text-red-500 transition-colors shrink-0"
                  title="Disable Tunnel"
                >
                  <span className="material-symbols-outlined text-[18px]">power_settings_new</span>
                </button>
              </>
            ) : tunnelEnabled && !tunnelLoading && !tunnelReachable ? (
              <>
                <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded border border-amber-300 dark:border-amber-800 bg-amber-500/5 text-sm text-amber-600 dark:text-amber-400">
                  <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                  {tunnelEverReachable ? "Tunnel reconnecting..." : "Tunnel checking..."}
                </div>
                <button
                  onClick={() => setShowDisableTunnelModal(true)}
                  className="p-2 hover:bg-red-500/10 rounded text-red-500 transition-colors shrink-0"
                  title="Disable Tunnel"
                >
                  <span className="material-symbols-outlined text-[18px]">power_settings_new</span>
                </button>
              </>
            ) : tunnelLoading ? (
              <>
                <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded border border-border bg-input text-sm text-text-muted">
                  <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                  {tunnelProgress || "Creating tunnel..."}
                </div>
                <button
                  onClick={() => { setTunnelLoading(false); setTunnelProgress(""); }}
                  className="p-2 hover:bg-red-500/10 rounded text-red-500 transition-colors shrink-0"
                  title="Stop"
                >
                  <span className="material-symbols-outlined text-[18px]">power_settings_new</span>
                </button>
              </>
            ) : tunnelStatus?.type === "error" ? (
              <>
                <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded border border-red-300 dark:border-red-800 bg-red-500/5 text-sm text-red-600 dark:text-red-400">
                  <span className="material-symbols-outlined text-sm">error</span>
                  {tunnelStatus.message}
                </div>
                <Button size="sm" icon="cloud_upload" onClick={() => setShowEnableTunnelModal(true)}>Enable</Button>
              </>
            ) : tunnelChecking ? (
              <>
                <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded border border-border bg-input text-sm text-text-muted">
                  <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                  Checking...
                </div>
                <button
                  onClick={() => setTunnelChecking(false)}
                  className="p-2 hover:bg-red-500/10 rounded text-red-500 transition-colors shrink-0"
                  title="Stop"
                >
                  <span className="material-symbols-outlined text-[18px]">power_settings_new</span>
                </button>
              </>
            ) : (
              <Button
                size="sm"
                icon="cloud_upload"
                onClick={() => {
                  if (isLoginUnsafe) {
                    setTunnelStatus({ type: "error", message: `Security required: ${unsafeReason}` });
                    return;
                  }
                  if (!requireApiKey) {
                    setTunnelStatus({ type: "error", message: "Security required: Enable \"Require API key\" before activating the tunnel." });
                    return;
                  }
                  setShowEnableTunnelModal(true);
                }}
              >
                Enable
              </Button>
            )}
          </div>
          {/* Tailscale */}
          <div className="flex items-center gap-2">
            <span className={`text-xs font-mono px-1.5 py-0.5 rounded shrink-0 min-w-[88px] text-center ${
              tsEnabled ? "bg-primary/10 text-primary" : "bg-surface-2 text-text-muted"
            }`}>Tailscale</span>
            {tsEnabled && !tsLoading && tsReachable ? (
              <>
                <Input value={`${tsUrl}/v1`} readOnly className="flex-1 font-mono text-sm" />
                <button
                  onClick={() => copy(`${tsUrl}/v1`, "ts_url")}
                  className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary transition-colors shrink-0"
                >
                  <span className="material-symbols-outlined text-[18px]">{copied === "ts_url" ? "check" : "content_copy"}</span>
                </button>
                <button
                  onClick={() => setShowDisableTsModal(true)}
                  className="p-2 hover:bg-red-500/10 rounded text-red-500 transition-colors shrink-0"
                  title="Disable Tailscale"
                >
                  <span className="material-symbols-outlined text-[18px]">power_settings_new</span>
                </button>
              </>
            ) : tsEnabled && !tsLoading && !tsReachable ? (
              <>
                <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded border border-amber-300 dark:border-amber-800 bg-amber-500/5 text-sm text-amber-600 dark:text-amber-400">
                  <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                  {tsEverReachable ? "Tailscale reconnecting..." : "Tailscale checking..."}
                </div>
                <button
                  onClick={() => setShowDisableTsModal(true)}
                  className="p-2 hover:bg-red-500/10 rounded text-red-500 transition-colors shrink-0"
                  title="Disable Tailscale"
                >
                  <span className="material-symbols-outlined text-[18px]">power_settings_new</span>
                </button>
              </>
            ) : (tsLoading || tsConnecting) ? (
              <>
                <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded border border-border bg-input text-sm text-text-muted">
                  <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                  {tsProgress || "Connecting..."}
                </div>
                {tsAuthUrl && (
                  <Button
                    size="sm"
                    icon="open_in_new"
                    onClick={() => window.open(tsAuthUrl, "tailscale_auth", "width=600,height=700,noopener,noreferrer")}
                  >
                    {tsAuthLabel || "Open"}
                  </Button>
                )}
                <button
                  onClick={() => { setTsLoading(false); setTsConnecting(false); setTsProgress(""); clearUserAuth(); }}
                  className="p-2 hover:bg-red-500/10 rounded text-red-500 transition-colors shrink-0"
                  title="Stop"
                >
                  <span className="material-symbols-outlined text-[18px]">power_settings_new</span>
                </button>
              </>
            ) : tsStatus?.type === "error" ? (
              <>
                <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded border border-red-300 dark:border-red-800 bg-red-500/5 text-sm text-red-600 dark:text-red-400">
                  <span className="material-symbols-outlined text-sm">error</span>
                  {tsStatus.message}
                </div>
                <Button size="sm" icon="vpn_lock" onClick={handleOpenTsModal}>Enable</Button>
              </>
            ) : (
              <Button
                size="sm"
                icon="vpn_lock"
                onClick={() => {
                  if (isLoginUnsafe) {
                    setTsStatus({ type: "error", message: `Security required: ${unsafeReason}` });
                    return;
                  }
                  handleOpenTsModal();
                }}
                className="bg-linear-to-r from-indigo-500 to-purple-500 hover:from-indigo-600 hover:to-purple-600 text-white!"
              >
                Enable
              </Button>
            )}
          </div>
        </div>

        {/* Pre-enable security gate banner */}
        {isLoginUnsafe && !tunnelEnabled && !tsEnabled && (
          <div className="mt-4">
            <SecurityWarning
              message={unsafeReason}
              action={{ label: "Open settings", href: "/dashboard/profile" }}
            />
          </div>
        )}

        {/* Security warnings when tunnel or tailscale is active */}
        {(tunnelEnabled || tsEnabled) && (
          <div className="mt-4 flex flex-col gap-2">
            {!requireApiKey && (
              <SecurityWarning
                message="Require API key is disabled — your endpoint is publicly accessible without authentication."
                action={{ label: "Enable", href: "#require-api-key" }}
              />
            )}
            {(!requireLogin || !hasPassword) && (
              <SecurityWarning
                message={
                  !requireLogin
                    ? "Require login is disabled — anyone can access your dashboard via tunnel."
                    : "Dashboard uses the default password — change it in Profile settings."
                }
                action={{
                  label: !requireLogin ? "Enable" : "Change password",
                  href: "/dashboard/profile",
                }}
              />
            )}
          </div>
        )}

        {/* Tunnel dashboard access option */}
        {(tunnelEnabled || tsEnabled) && (
          <div className="mt-4 pt-4 border-t border-border flex items-center gap-3">
            <Toggle
              checked={tunnelDashboardAccess}
              onChange={() => handleTunnelDashboardAccess(!tunnelDashboardAccess)}
            />
            <div className="flex items-center gap-1.5">
              <p className="font-medium text-sm">Allow dashboard access via tunnel</p>
              <Tooltip text="When enabled, the dashboard can be accessed through your tunnel or Tailscale URL (login still required). When disabled, dashboard access via tunnel/Tailscale is completely blocked.">
                <span className="material-symbols-outlined text-[14px] text-text-muted cursor-help">help</span>
              </Tooltip>
            </div>
          </div>
        )}
      </Card>

      {/* API Keys */}
      <Card id="require-api-key">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">vpn_key</span>
            API Keys
          </h2>
          <Button icon="add" onClick={() => setShowAddModal(true)}>
            Create Key
          </Button>
        </div>

        <div className="flex items-center justify-between pb-4 mb-4 border-b border-border">
          <div>
            <p className="font-medium">Require API key</p>
            <p className="text-sm text-text-muted">
              Requests without a valid key will be rejected
            </p>
          </div>
          <Toggle
            checked={requireApiKey}
            onChange={() => handleRequireApiKey(!requireApiKey)}
          />
        </div>

        {isRemoteHost && !requireApiKey && (
          <div className="mb-4 -mt-2">
            <SecurityWarning message="Endpoint is exposed without an API key." />
          </div>
        )}

        {keys.length === 0 ? (
          <div className="text-center py-12">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 text-primary mb-4">
              <span className="material-symbols-outlined text-[32px]">vpn_key</span>
            </div>
            <p className="text-text-main font-medium mb-1">No API keys yet</p>
            <p className="text-sm text-text-muted mb-4">Create your first API key to get started</p>
            <Button icon="add" onClick={() => setShowAddModal(true)}>
              Create Key
            </Button>
          </div>
        ) : (
          <div className="flex flex-col">
            {/* R11 bulk selection bar */}
            {keys.length > 0 && (
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 text-xs text-text-muted">
                  <input
                    type="checkbox"
                    checked={selectedKeyIds.length > 0 && selectedKeyIds.length === keys.length}
                    onChange={(e) => setSelectedKeyIds(e.target.checked ? keys.map((k) => k.id) : [])}
                  />
                  Select all
                </label>
                {selectedKeyIds.length > 0 && (
                  <>
                    <span className="text-xs text-text-muted">{selectedKeyIds.length} selected</span>
                    <Button size="sm" variant="outline" onClick={() => setShowBulkModal(true)}>Bulk edit</Button>
                    <button type="button" onClick={() => setSelectedKeyIds([])} className="text-xs text-text-muted hover:text-text-main">Clear</button>
                  </>
                )}
              </div>
            )}
            {keys.map((key) => (
              <div
                key={key.id}
                className={`group flex items-start justify-between gap-3 py-3 border-b border-black/[0.03] dark:border-white/[0.03] last:border-b-0 ${key.isActive === false ? "opacity-60" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={selectedKeyIds.includes(key.id)}
                  onChange={() => toggleKeySelect(key.id)}
                  aria-label={`Select ${key.name}`}
                  className="mt-1 shrink-0 accent-indigo-500"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{key.name}</p>
                  <div className="flex items-center gap-2 mt-1 min-w-0 flex-wrap">
                    <code className="text-xs text-text-muted font-mono break-all min-w-0">
                      {visibleKeys.has(key.id) ? key.key : maskKey(key.key)}
                    </code>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => toggleKeyVisibility(key.id)}
                        className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary transition-all"
                        title={visibleKeys.has(key.id) ? "Hide key" : "Show key"}
                      >
                        <span className="material-symbols-outlined text-[14px]">
                          {visibleKeys.has(key.id) ? "visibility_off" : "visibility"}
                        </span>
                      </button>
                      <button
                        onClick={() => copy(key.key, key.id)}
                        className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary transition-all"
                      >
                        <span className="material-symbols-outlined text-[14px]">
                          {copied === key.id ? "check" : "content_copy"}
                        </span>
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-text-muted mt-1">
                    Created {new Date(key.createdAt).toLocaleDateString()}
                  </p>
                  {key.expiresAt && (
                    <p className={`text-xs mt-1 ${new Date(key.expiresAt).getTime() <= Date.now() ? "text-red-500 font-medium" : "text-text-muted"}`}>
                      {new Date(key.expiresAt).getTime() <= Date.now()
                        ? `Expired ${new Date(key.expiresAt).toLocaleDateString()}`
                        : `Expires ${new Date(key.expiresAt).toLocaleDateString()}`}
                    </p>
                  )}
                  {key.isActive === false && (
                    <p className="text-xs text-orange-500 mt-1">Paused</p>
                  )}
                  <KeyAccessControls
                    apiKey={key}
                    onChange={(access) => handleUpdateKeyAccess(key.id, access)}
                    onExpiryChange={(expiresAt) => handleUpdateKeyExpiry(key.id, expiresAt)}
                    onQuotaChange={(quota) => handleUpdateKeyQuota(key.id, quota)}
                    onLimitsChange={(limits) => handleUpdateKeyLimits(key.id, limits)}
                    onRequestRestrict={() => setConfirmState({
                      title: "Restrict API Key",
                      message: `Restrict API key "${key.name}"?\n\nIt will only be able to call the combos and models you add. Until you add one, it can call nothing.`,
                      onConfirm: async () => {
                        setConfirmState(null);
                        handleUpdateKeyAccess(key.id, { restricted: true, allow: key.access?.allow || [] });
                      }
                    })}
                  />
                </div>
                <div className="flex items-center gap-2 shrink-0 pt-0.5">
                  <Toggle
                    size="sm"
                    checked={key.isActive ?? true}
                    onChange={(checked) => {
                      if (key.isActive && !checked) {
                        setConfirmState({
                          title: "Pause API Key",
                          message: `Pause API key "${key.name}"?\n\nThis key will stop working immediately but can be resumed later.`,
                          onConfirm: async () => {
                            setConfirmState(null);
                            handleToggleKey(key.id, checked);
                          }
                        });
                      } else {
                        handleToggleKey(key.id, checked);
                      }
                    }}
                    title={key.isActive ? "Pause key" : "Resume key"}
                  />
                  <button
                    onClick={() => handleDeleteKey(key.id)}
                    className="p-2 hover:bg-red-500/10 rounded text-red-500 transition-all"
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {keys.length > 0 && (
          <div className="mt-4">
            <FirstRequestSnippet baseUrl={currentEndpoint} keyName={keys[0]?.name} />
          </div>
        )}
      </Card>

      {/* R11 bulk edit modal — applies to every selected key */}
      <Modal
        isOpen={showBulkModal}
        title={`Bulk edit ${selectedKeyIds.length} key(s)`}
        size="lg"
        onClose={() => setShowBulkModal(false)}
      >
        <div className="flex flex-col gap-4">
          <p className="text-xs text-text-muted">Only filled fields change. Empty fields leave the key&apos;s current value alone. Clearing beats setting when both are chosen for the same field.</p>
          <div className="flex flex-wrap items-end gap-2">
            <Input label="Expiry date" type="date" value={bulkDraft.expiresAt} onChange={(e) => setBulkDraft((d) => ({ ...d, expiresAt: e.target.value }))} />
            <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={bulkDraft.clearExpiry} onChange={(e) => setBulkDraft((d) => ({ ...d, clearExpiry: e.target.checked }))} /> Clear expiry</label>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Input label="Token quota limit" type="number" min="1" value={bulkDraft.quotaLimit} onChange={(e) => setBulkDraft((d) => ({ ...d, quotaLimit: e.target.value }))} placeholder="100000" />
            <Input label="Window (hours)" type="number" min="1" value={bulkDraft.quotaWindow} onChange={(e) => setBulkDraft((d) => ({ ...d, quotaWindow: e.target.value }))} />
            <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={bulkDraft.clearQuota} onChange={(e) => setBulkDraft((d) => ({ ...d, clearQuota: e.target.checked }))} /> Clear quota</label>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Input label="TPM limit" type="number" min="1" value={bulkDraft.tpm} onChange={(e) => setBulkDraft((d) => ({ ...d, tpm: e.target.value }))} placeholder="e.g. 60000" />
            <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={bulkDraft.clearTpm} onChange={(e) => setBulkDraft((d) => ({ ...d, clearTpm: e.target.checked }))} /> Clear limits</label>
          </div>
          <Input label="Model policy — allowed combos/models (comma-separated)" value={bulkDraft.allowText} onChange={(e) => setBulkDraft((d) => ({ ...d, allowText: e.target.value }))} placeholder="combo-a, dahl/deepseek-ai/DeepSeek-V4-Flash-0731" />
          <label className="flex flex-col gap-1 text-xs text-text-muted">Active
            <select value={bulkDraft.active} onChange={(e) => setBulkDraft((d) => ({ ...d, active: e.target.value }))} className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-main">
              <option value="">Leave unchanged</option>
              <option value="pause">Pause all selected</option>
              <option value="resume">Resume all selected</option>
            </select>
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowBulkModal(false)}>Cancel</Button>
            <Button onClick={applyBulkEdit} disabled={bulkBusy}>{bulkBusy ? "Applying…" : "Apply to selected"}</Button>
          </div>
        </div>
      </Modal>

      {/* Add Key Modal */}
      <Modal
        isOpen={showAddModal}
        title="Create API Key"
        size="lg"
        onClose={closeAddModal}
      >
        <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-0.5">
          <Input
            label="Key Name"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            placeholder="Production Key"
          />

          {/* 9Router Pro: optional settings, applied at creation */}
          <div className="border-t border-border-subtle pt-3">
            <div className="flex items-baseline gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Key settings</span>
              <span className="text-[10px] font-medium uppercase tracking-wider text-text-subtle">Optional</span>
            </div>

            {/* Restrict access */}
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-sm text-text-main">Restrict access</span>
              <Toggle
                size="sm"
                checked={newKeyDraft.restricted}
                onChange={(checked) => setNewKeyDraft((d) => ({ ...d, restricted: checked }))}
              />
            </div>
            {newKeyDraft.restricted && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {newKeyDraft.allow.length === 0 && (
                  <span className="text-xs text-orange-500">Nothing added yet — this key will be able to call nothing.</span>
                )}
                {newKeyDraft.allow.map((entry) => (
                  <span key={entry} className="flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 py-0.5 pl-2.5 pr-1.5 font-mono text-xs text-text-main">
                    {entry}
                    <button
                      onClick={() => setNewKeyDraft((d) => ({ ...d, allow: d.allow.filter((e) => e !== entry) }))}
                      className="rounded-full p-0.5 text-text-muted transition-colors hover:text-red-500"
                      aria-label={`Remove ${entry}`}
                    >
                      <span className="material-symbols-outlined block leading-none" style={{ fontSize: "12px" }}>close</span>
                    </button>
                  </span>
                ))}
                <button
                  onClick={openCreatePicker}
                  className="flex items-center gap-0.5 rounded-full border border-dashed border-black/15 px-2.5 py-0.5 text-xs font-medium text-primary transition-colors hover:border-primary/50 dark:border-white/15"
                >
                  <span className="material-symbols-outlined leading-none" style={{ fontSize: "14px" }}>add</span>
                  Add combo or model
                </button>
              </div>
            )}

            {/* API key token quota (per-key budget — not provider balances) */}
            <div className="mt-4 flex items-center justify-between gap-3 border-t border-border-subtle pt-3">
              <span className="text-sm text-text-main">API key token quota</span>
              <Toggle
                size="sm"
                checked={newKeyDraft.quotaEnabled}
                onChange={(checked) => setNewKeyDraft((d) => ({ ...d, quotaEnabled: checked }))}
              />
            </div>
            {newKeyDraft.quotaEnabled && (
              <>
              <p className="mt-1 text-[11px] text-text-muted">
                Caps what this key can spend. Provider-side balances live on the{" "}
                <Link href="/dashboard/quota" className="text-primary hover:underline">Provider Quota</Link>{" "}
                page.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  type="number"
                  min="1"
                  className="w-32 rounded-lg border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-text-main outline-none transition-colors focus:border-brand-500"
                  value={newKeyDraft.quotaLimit}
                  onChange={(e) => setNewKeyDraft((d) => ({ ...d, quotaLimit: e.target.value }))}
                  placeholder="100000"
                />
                <span className="text-xs text-text-muted">tokens per</span>
                <select
                  className="rounded-lg border border-border bg-bg px-2 py-1.5 text-xs text-text-main outline-none transition-colors focus:border-brand-500"
                  value={newKeyDraft.quotaWindow}
                  onChange={(e) => setNewKeyDraft((d) => ({ ...d, quotaWindow: Number(e.target.value) }))}
                >
                  <option value={24}>24 hours</option>
                  <option value={168}>7 days</option>
                  <option value={720}>30 days</option>
                </select>
              </div>
              {!(parseInt(newKeyDraft.quotaLimit, 10) > 0) && (
                <p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                  Enter a positive number of tokens — an empty, zero, or invalid
                  value is ignored and the key is created without a quota.
                </p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-xs text-text-muted">Max spend $</span>
                <input
                  type="number"
                  min="0.01"
                  step="any"
                  className="w-24 rounded-lg border border-border bg-bg px-2 py-1.5 text-xs text-text-main outline-none transition-colors focus:border-brand-500"
                  value={newKeyDraft.quotaCostLimit}
                  onChange={(e) => setNewKeyDraft((d) => ({ ...d, quotaCostLimit: e.target.value }))}
                  placeholder="No cap"
                />
                <span className="text-xs text-text-muted">USD per same window</span>
              </div>
              </>
            )}

            {/* Expiry */}
            <div className="mt-4 border-t border-border-subtle pt-3">
              <span className="text-sm text-text-main">Expiry</span>
              <span className="mt-0.5 block text-[11px] text-text-muted">Empty = never expires. After this date the key is rejected everywhere.</span>
              <input
                type="date"
                className="mt-2 rounded-lg border border-border bg-bg px-2 py-1.5 text-xs text-text-main outline-none transition-colors focus:border-brand-500"
                value={newKeyDraft.expiresAt}
                onChange={(e) => setNewKeyDraft((d) => ({ ...d, expiresAt: e.target.value }))}
              />
            </div>

            {/* Key limits */}
            <div className="mt-4 border-t border-border-subtle pt-3">
              <span className="text-sm text-text-main">Key limits</span>
              <span className="mt-0.5 block text-[11px] text-text-muted">Request-rate caps for this key. Empty = unlimited.</span>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {[
                  { field: "rpm", label: "Requests / min" },
                  { field: "tpm", label: "Tokens / min" },
                  { field: "rph", label: "Requests / hour" },
                  { field: "rpd", label: "Requests / day" },
                  { field: "maxConcurrent", label: "Max concurrent" },
                ].map(({ field, label }) => (
                  <label key={field} className="block">
                    <span className="mb-1 block text-[11px] text-text-muted">{label}</span>
                    <input
                      type="number"
                      min="1"
                      className="w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-text-main outline-none transition-colors focus:border-brand-500"
                      value={newKeyDraft.limits[field]}
                      onChange={(e) => setNewKeyDraft((d) => ({ ...d, limits: { ...d.limits, [field]: e.target.value } }))}
                      placeholder="Unlimited"
                    />
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div className="flex gap-2">
            <Button onClick={handleCreateKey} fullWidth disabled={!newKeyName.trim()}>
              Create
            </Button>
            <Button onClick={closeAddModal} variant="ghost" fullWidth>
              Cancel
            </Button>
          </div>
        </div>
        {createPickerOpen && (
          <ModelSelectModal
            isOpen={createPickerOpen}
            onClose={() => setCreatePickerOpen(false)}
            onSelect={(model) => {
              const value = model?.value;
              if (value) {
                setNewKeyDraft((d) => (d.allow.some((e) => e.toLowerCase() === value.toLowerCase()) ? d : { ...d, allow: [...d.allow, value] }));
              }
            }}
            onDeselect={(model) => {
              const value = String(model?.value || "");
              setNewKeyDraft((d) => ({ ...d, allow: d.allow.filter((e) => e.toLowerCase() !== value.toLowerCase()) }));
            }}
            activeProviders={createPickerProviders}
            modelAliases={createPickerAliases}
            title="Allowed for the new key"
            addedModelValues={newKeyDraft.allow}
            closeOnSelect={false}
          />
        )}
      </Modal>

      {/* Created Key Modal */}
      <Modal
        isOpen={!!createdKey}
        title="API Key Created"
        onClose={() => { setCreatedKey(null); setCreatedKeyName(""); }}
      >
        <div className="flex flex-col gap-4">
          <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
            <p className="text-sm text-yellow-800 dark:text-yellow-200 mb-2 font-medium">
              Save this key now!
            </p>
            <p className="text-sm text-yellow-700 dark:text-yellow-300">
              Store this key securely. You can view or copy it later from the API Keys list.
            </p>
          </div>
          <div className="flex gap-2">
            <Input
              value={createdKey || ""}
              readOnly
              className="flex-1 font-mono text-sm"
            />
            <Button
              variant="secondary"
              icon={copied === "created_key" ? "check" : "content_copy"}
              onClick={() => copy(createdKey, "created_key")}
            >
              {copied === "created_key" ? "Copied!" : "Copy"}
            </Button>
          </div>
          <FirstRequestSnippet baseUrl={currentEndpoint} keyName={createdKeyName} />
          <Button onClick={() => { setCreatedKey(null); setCreatedKeyName(""); }} fullWidth>
            Done
          </Button>
        </div>
      </Modal>

      {/* Enable Tunnel Modal */}
      <Modal
        isOpen={showEnableTunnelModal}
        title="Enable Tunnel"
        onClose={() => setShowEnableTunnelModal(false)}
      >
        <div className="flex flex-col gap-4">
          <div className="bg-surface-2 border border-border-subtle rounded-lg p-4">
            <div className="flex items-start gap-3">
              <span className="material-symbols-outlined text-primary">cloud_upload</span>
              <div>
                <p className="text-sm text-text-main font-medium mb-1">
                  Cloudflare Tunnel
                </p>
                <p className="text-sm text-text-muted">
                  Expose your local 9Router to the internet. No port forwarding, no static IP needed. Share endpoint URL with your team or use it in Cursor, Cline, and other AI tools from anywhere.
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {TUNNEL_BENEFITS.map((benefit) => (
              <div key={benefit.title} className="flex flex-col items-center text-center p-3 rounded-lg bg-sidebar/50">
                <span className="material-symbols-outlined text-xl text-primary mb-1">{benefit.icon}</span>
                <p className="text-xs font-semibold">{benefit.title}</p>
                <p className="text-xs text-text-muted">{benefit.desc}</p>
              </div>
            ))}
          </div>

          <p className="text-xs text-text-muted">
            Requires outbound port 7844 (TCP/UDP). Connection may take 10-30s.
          </p>

          <div className="flex gap-2">
            <Button onClick={handleEnableTunnel} fullWidth>
              Start Tunnel
            </Button>
            <Button onClick={() => setShowEnableTunnelModal(false)} variant="ghost" fullWidth>Cancel</Button>
          </div>
        </div>
      </Modal>

      {/* Disable Cloudflare Tunnel Modal */}
      <Modal
        isOpen={showDisableTunnelModal}
        title="Disable Tunnel"
        onClose={() => !tunnelLoading && setShowDisableTunnelModal(false)}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">The Cloudflare tunnel will be disconnected. Remote access via tunnel URL will stop working.</p>
          <div className="flex gap-2">
            <Button onClick={handleDisableTunnel} fullWidth disabled={tunnelLoading} variant="danger">
              {tunnelLoading ? "Disabling..." : "Disable"}
            </Button>
            <Button onClick={() => setShowDisableTunnelModal(false)} variant="ghost" fullWidth disabled={tunnelLoading}>Cancel</Button>
          </div>
        </div>
      </Modal>

      {/* Tailscale Modal */}
      <Modal
        isOpen={showTsModal}
        title="Tailscale Funnel"
        onClose={() => { if (!tsInstalling) { setShowTsModal(false); setTsSudoPassword(""); setTsStatus(null); } }}
      >
        <div className="flex flex-col gap-4">
          {/* Checking state */}
          {tsInstalled === null && (
            <p className="text-sm text-text-muted flex items-center gap-2">
              <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
              Checking...
            </p>
          )}

          {/* Not installed */}
          {tsInstalled === false && !tsInstalling && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-text-muted">Tailscale is not installed. Install it to enable Funnel.</p>
              <div className="flex gap-2">
                <Button onClick={handleInstallTailscale} fullWidth>
                  Install Tailscale
                </Button>
                <Button onClick={() => setShowTsModal(false)} variant="ghost" fullWidth>Cancel</Button>
              </div>
            </div>
          )}

          {/* Installing with progress log */}
          {tsInstalling && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-sm text-text-muted">
                <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                Installing Tailscale...
              </div>
              {tsInstallLog.length > 0 && (
                <div ref={tsLogRef} className="bg-black/5 dark:bg-white/5 rounded p-2 max-h-40 overflow-y-auto font-mono text-xs text-text-muted">
                  {tsInstallLog.map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Installed: show Connect button */}
          {tsInstalled === true && !tsInstalling && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                <span className="material-symbols-outlined text-[16px]">check_circle</span>
                Tailscale installed
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => handleConnectTailscale()}
                  fullWidth
                >
                  Connect
                </Button>
                <Button onClick={() => setShowTsModal(false)} variant="ghost" fullWidth>Cancel</Button>
              </div>
            </div>
          )}

          {tsStatus && <StatusAlert status={tsStatus} />}
        </div>
      </Modal>

      {/* Disable Tailscale Modal */}
      <Modal
        isOpen={showDisableTsModal}
        title="Disable Tailscale"
        onClose={() => !tsLoading && setShowDisableTsModal(false)}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">Tailscale Funnel will be stopped. Remote access via Tailscale URL will stop working.</p>
          <div className="flex gap-2">
            <Button onClick={handleDisableTailscale} fullWidth disabled={tsLoading} variant="danger">
              {tsLoading ? "Disabling..." : "Disable"}
            </Button>
            <Button onClick={() => setShowDisableTsModal(false)} variant="ghost" fullWidth disabled={tsLoading}>Cancel</Button>
          </div>
        </div>
      </Modal>

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />
    </div>
  );
}


APIPageClient.propTypes = {
  machineId: PropTypes.string.isRequired,
};
