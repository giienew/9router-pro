"use client";

import { useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import {
  Card,
  CardSkeleton,
  Badge,
  Button,
  Toggle,
} from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { getProviderIconSrc } from "@/shared/utils/providerIcon";
import { OAUTH_PROVIDERS, APIKEY_PROVIDERS } from "@/shared/constants/config";
import {
  FREE_PROVIDERS,
  FREE_TIER_PROVIDERS,
  WEB_COOKIE_PROVIDERS,
  OPENAI_COMPATIBLE_PREFIX,
  ANTHROPIC_COMPATIBLE_PREFIX,
} from "@/shared/constants/providers";
import Link from "next/link";
import { getErrorCode, getRelativeTime } from "@/shared/utils";
import { useNotificationStore } from "@/store/notificationStore";
import { useHeaderSearchStore } from "@/store/headerSearchStore";
import { useVisibleCount } from "@/shared/hooks/useVisibleCount";
import { useProviderSummary } from "@/shared/hooks/useProviderSummary";
import ModelAvailabilityBadge from "./components/ModelAvailabilityBadge";
import AddCompatibleModal from "./components/AddCompatibleModal";
import CatalogSearchModal from "./components/CatalogSearchModal";
import { STATUS_FILTER_OPTIONS, matchesStatusFilter } from "./utils";

// Plain-language meaning for the raw error codes shown on provider cards
// (B-F17): a code alone ("429") tells the user nothing about what broke or
// what to do. Rendered as the badge's hover tooltip.
const ERROR_CODE_EXPLANATIONS = {
  AUTH: "Authentication failed — the credential is invalid or expired. Reconnect the provider.",
  RUNTIME: "The provider call crashed at runtime — check the console log for details.",
  NET: "Network error — the router could not reach the provider. Check connectivity.",
  "401": "Authentication failed — the credential is invalid or expired. Reconnect the provider.",
  "403": "Access denied — this account may not use the requested model.",
  "404": "Not found — the model or endpoint no longer exists on the provider.",
  "429": "Rate limited — too many requests. Wait a bit; it usually clears on its own.",
  "5XX": "Provider server error — try again later.",
};

function explainErrorCode(errorCode) {
  if (!errorCode) return null;
  if (ERROR_CODE_EXPLANATIONS[errorCode]) return ERROR_CODE_EXPLANATIONS[errorCode];
  const numeric = Number(errorCode);
  if (Number.isFinite(numeric)) {
    if (numeric >= 400 && numeric < 500) return "Client error — the request was rejected by the provider. Check the credential and model.";
    if (numeric >= 500) return "Provider server error — try again later.";
  }
  return null;
}

// Tap-to-expand error explanation (G13/G20): the old hover-only `title`
// tooltip never fires on touch devices, so the badge is now a button that
// expands the plain-language explanation inline. Desktop hover still shows
// the same text via `title`.
function ErrorBadgeWithExplanation({ errText, explanation }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        title={explanation}
        aria-expanded={expanded}
        className="cursor-pointer"
      >
        <Badge variant="error" size="sm" dot>
          {errText}
        </Badge>
      </button>
      {expanded && (
        <span className="max-w-[260px] text-xs leading-relaxed text-text-muted">
          {explanation}
        </span>
      )}
    </span>
  );
}

function getStatusDisplay(connected, error, errorCode) {
  const parts = [];
  if (connected > 0) {
    parts.push(
      <Badge key="connected" variant="success" size="sm" dot>
        {connected} Connected
      </Badge>,
    );
  }
  if (error > 0) {
    const errText = errorCode
      ? `${error} Error (${errorCode})`
      : `${error} Error`;
    const explanation = explainErrorCode(errorCode);
    parts.push(
      explanation ? (
        <ErrorBadgeWithExplanation key="error" errText={errText} explanation={explanation} />
      ) : (
        <Badge key="error" variant="error" size="sm" dot>
          {errText}
        </Badge>
      ),
    );
  }
  if (parts.length === 0) {
    return <span className="text-text-muted">No connections</span>;
  }
  return parts;
}

function getConnectionErrorTag(connection) {
  if (!connection) return null;

  const explicitType = connection.lastErrorType;
  if (explicitType === "runtime_error") return "RUNTIME";
  if (
    explicitType === "upstream_auth_error" ||
    explicitType === "auth_missing" ||
    explicitType === "token_refresh_failed" ||
    explicitType === "token_expired"
  )
    return "AUTH";
  if (explicitType === "upstream_rate_limited") return "429";
  if (explicitType === "upstream_unavailable") return "5XX";
  if (explicitType === "network_error") return "NET";

  const numericCode = Number(connection.errorCode);
  if (Number.isFinite(numericCode) && numericCode >= 400)
    return String(numericCode);

  const fromMessage = getErrorCode(connection.lastError);
  if (fromMessage === "401" || fromMessage === "403") return "AUTH";
  if (fromMessage && fromMessage !== "ERR") return fromMessage;

  const msg = (connection.lastError || "").toLowerCase();
  if (
    msg.includes("runtime") ||
    msg.includes("not runnable") ||
    msg.includes("not installed")
  )
    return "RUNTIME";
  if (
    msg.includes("invalid api key") ||
    msg.includes("token invalid") ||
    msg.includes("revoked") ||
    msg.includes("unauthorized")
  )
    return "AUTH";

  return "ERR";
}

// Providers with no connections collapse into one compact list per section so
// the page stays short; every row links to the provider page to connect it.
function NotConnectedProviders({ entries, forceOpen }) {
  const [open, setOpen] = useState(false);
  const expanded = forceOpen || open;
  if (entries.length === 0) return null;
  return (
    <div className="rounded-xl border border-border-subtle">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2 px-3.5 py-2.5 text-left"
        aria-expanded={expanded}
      >
        <span
          className="material-symbols-outlined text-[18px] text-text-muted transition-transform"
          style={{ transform: expanded ? "rotate(180deg)" : "none" }}
        >
          expand_more
        </span>
        <span className="text-sm font-medium text-text-muted">Not connected</span>
        <span className="rounded-full bg-black/5 px-2 py-0.5 text-[11px] font-medium text-text-muted dark:bg-white/10">
          {entries.length}
        </span>
        <span className="ml-auto hidden text-xs text-text-subtle sm:block">
          Tap a provider to connect it
        </span>
      </button>
      {expanded && (
        <div className="flex flex-col divide-y divide-border-subtle border-t border-border-subtle">
          {entries.map(([key, info]) => (
            <Link
              key={key}
              href={`/dashboard/providers/${key}`}
              className="flex items-center gap-3 px-3.5 py-2 transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
            >
              <div
                className="flex size-7 shrink-0 items-center justify-center rounded-lg"
                style={{
                  backgroundColor: `${info.color?.length > 7 ? info.color : (info.color || "#888") + "15"}`,
                }}
              >
                <ProviderIcon
                  src={`/providers/${key}.png`}
                  alt={info.name}
                  size={22}
                  className="max-h-[24px] max-w-[24px] rounded-md object-contain"
                  fallbackText={info.textIcon || key.slice(0, 2).toUpperCase()}
                  fallbackColor={info.color}
                />
              </div>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {info.name}
              </span>
              <span className="flex shrink-0 items-center gap-1 rounded-lg border border-primary/40 px-2 py-1 text-[11px] font-semibold text-primary">
                <span className="material-symbols-outlined text-[13px]">add</span>
                Connect
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ProvidersPage() {
  const { statsMap, setStatsMap, breakers } = useProviderSummary();
  const [providerNodes, setProviderNodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddCompatibleModal, setShowAddCompatibleModal] = useState(false);
  const [showCatalogSearch, setShowCatalogSearch] = useState(false);
  const [showAddAnthropicCompatibleModal, setShowAddAnthropicCompatibleModal] =
    useState(false);
  const [testingMode, setTestingMode] = useState(null);
  const [testResults, setTestResults] = useState(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [autoProxyForTests, setAutoProxyForTests] = useState(false);
  const notify = useNotificationStore();

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/settings");
        const data = await res.json();
        setAutoProxyForTests(data?.autoProxyForTests === true);
      } catch { /* the toggle just stays off */ }
    })();
  }, []);

  const toggleAutoProxyForTests = async (value) => {
    setAutoProxyForTests(value);
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoProxyForTests: value }),
      });
    } catch { /* server state re-read on next visit */ }
  };
  const searchQuery = useHeaderSearchStore((s) => s.query);
  const registerSearch = useHeaderSearchStore((s) => s.register);
  const unregisterSearch = useHeaderSearchStore((s) => s.unregister);

  useEffect(() => {
    registerSearch("Search providers...");
    return () => unregisterSearch();
  }, [registerSearch, unregisterSearch]);

  const matchSearch = (name) => {
    if (!searchQuery.trim()) return true;
    if (!name) return false;
    return name.toLowerCase().includes(searchQuery.trim().toLowerCase());
  };

  const sortByPriority = (entries, authType) =>
    [...entries].sort(([ka, a], [kb, b]) => {
      const pa = a.priority ?? 999;
      const pb = b.priority ?? 999;
      if (pa !== pb) return pa - pb;
      const sa = getProviderStats(ka, authType);
      const sb = getProviderStats(kb, authType);
      const ca = sa.connected > 0 ? 1 : 0;
      const cb = sb.connected > 0 ? 1 : 0;
      if (ca !== cb) return cb - ca;
      return (a.name || "").localeCompare(b.name || "");
    });

  const sortItemsByPriority = (items, authType) =>
    [...items].sort((a, b) => {
      const pa = a.priority ?? 999;
      const pb = b.priority ?? 999;
      if (pa !== pb) return pa - pb;
      const sa = getProviderStats(a.id, authType);
      const sb = getProviderStats(b.id, authType);
      const ca = sa.connected > 0 ? 1 : 0;
      const cb = sb.connected > 0 ? 1 : 0;
      if (ca !== cb) return cb - ca;
      return (a.name || "").localeCompare(b.name || "");
    });

  useEffect(() => {
    const fetchData = async () => {
      try {
        const nodesRes = await fetch("/api/provider-nodes");
        const nodesData = await nodesRes.json();
        if (nodesRes.ok) setProviderNodes(nodesData.nodes || []);
      } catch (error) {
        console.log("Error fetching data:", error);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  // Stats come pre-aggregated from /api/providers?summary=1 (9Router Pro) —
  // the page no longer downloads every connection just to count them.
  const getProviderStats = (providerId, authType) => {
    const authTypes = Array.isArray(authType) ? authType : [authType];
    let connected = 0;
    let error = 0;
    let total = 0;
    let anyEntry = false;
    let allDisabled = true;
    let latestError = null;
    for (const t of authTypes) {
      const s = statsMap[`${providerId}|${t}`];
      if (!s) continue;
      anyEntry = true;
      connected += s.connected || 0;
      error += s.error || 0;
      total += s.total || 0;
      if (!s.allDisabled) allDisabled = false;
      if (
        s.latestError &&
        (!latestError ||
          new Date(s.latestError.lastErrorAt || 0) >
            new Date(latestError.lastErrorAt || 0))
      ) {
        latestError = s.latestError;
      }
    }
    const errorCode = latestError ? getConnectionErrorTag(latestError) : null;
    const errorTime = latestError?.lastErrorAt
      ? getRelativeTime(latestError.lastErrorAt)
      : null;

    return {
      connected,
      error,
      total,
      errorCode,
      errorTime,
      allDisabled: anyEntry && total > 0 ? allDisabled : false,
      // Provider breaker (P3-27) keyed by registry provider id. Compatible
      // nodes use synthetic ids, so they never match — their single
      // endpoint is covered by the connection-cooldown layer instead.
      breaker: breakers[providerId] || null,
    };
  };

  const matchStatus = (stats, isNoAuth) =>
    matchesStatusFilter(statusFilter, stats, isNoAuth);

  // Toggle all connections for a provider on/off. authType may be a single
  // string or an array (kiro counts oauth + api_key/apikey together).
  const handleToggleProvider = async (providerId, authType, newActive) => {
    const authTypes = Array.isArray(authType) ? authType : [authType];
    // Optimistic: the provider switch reflects allDisabled only.
    setStatsMap((prev) => {
      const next = { ...prev };
      for (const t of authTypes) {
        const key = `${providerId}|${t}`;
        if (next[key]) next[key] = { ...next[key], allDisabled: !newActive };
      }
      return next;
    });
    // One bulk UPDATE server-side (was: one PUT per connection).
    await fetch("/api/providers", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: providerId, authTypes, isActive: newActive }),
    }).catch(() => {});
  };

  const batchJobRef = useRef(null);

  const handleBatchTest = async (mode, providerId = null) => {
    if (testingMode) return;
    const jobId = `bt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    batchJobRef.current = jobId;
    setTestingMode(mode === "provider" ? providerId : mode);
    setTestResults(null);
    try {
      const res = await fetch("/api/providers/test-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, providerId, jobId }),
      });
      const data = await res.json();
      setTestResults(data);
      if (data.summary) {
        const { passed, failed, total, planned } = data.summary;
        if (data.stopped) {
          notify.warning(
            `Test stopped — ${total} of ${planned ?? total} connections tested (${passed} passed, ${failed} failed)`,
          );
        } else if (failed === 0) notify.success(`All ${total} tests passed`);
        else notify.warning(`${passed}/${total} passed, ${failed} failed`);
      }
    } catch (error) {
      setTestResults({ error: "Test request failed" });
      notify.error("Provider test failed");
    } finally {
      setTestingMode(null);
      batchJobRef.current = null;
    }
  };

  // Ask the server to stop the running batch; the batch request itself
  // returns the partial results, which handleBatchTest then reports.
  const handleStopBatchTest = async () => {
    const jobId = batchJobRef.current;
    if (!jobId) return;
    await fetch("/api/providers/test-batch/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId }),
    }).catch(() => {});
  };

  const compatibleProviders = providerNodes
    .filter((node) => node.type === "openai-compatible")
    .map((node) => ({
      id: node.id,
      name: node.name || "OpenAI Compatible",
      color: "#10A37F",
      textIcon: "OC",
      apiType: node.apiType,
      baseUrl: node.baseUrl || "",
    }))
    .filter(
      (p) => matchSearch(p.name) && matchStatus(getProviderStats(p.id, "apikey")),
    );

  const anthropicCompatibleProviders = providerNodes
    .filter((node) => node.type === "anthropic-compatible")
    .map((node) => ({
      id: node.id,
      name: node.name || "Anthropic Compatible",
      color: "#D97757",
      textIcon: "AC",
      baseUrl: node.baseUrl || "",
    }))
    .filter(
      (p) => matchSearch(p.name) && matchStatus(getProviderStats(p.id, "apikey")),
    );

  // Dual-auth providers (oauth + apikey) store API keys as authType "apikey"
  // (and sometimes "api_key"). Card stats must count both so totals match detail.
  // kiro has no authModes in registry but accepts both (headless uses "api_key").
  const dualAuthTypes = (info, key) => {
    if (key === "kiro") return ["oauth", "apikey", "api_key"];
    const modes = info?.authModes;
    // Free-tier and API-key providers default to supporting apikey even when the
    // registry entry omits authModes (e.g. cloudflare-ai, byteplus, ollama,
    // vertex) — otherwise their apikey connections are invisible on the grid card.
    if (!Array.isArray(modes)) {
      return key in FREE_TIER_PROVIDERS || key in APIKEY_PROVIDERS
        ? ["oauth", "apikey", "api_key"]
        : "oauth";
    }
    if (!modes.includes("apikey")) return "oauth";
    return ["oauth", "apikey", "api_key"];
  };

  const oauthEntries = sortByPriority(
    Object.entries(OAUTH_PROVIDERS).filter(
      ([key, info]) =>
        !info.hidden &&
        matchSearch(info.name) &&
        matchStatus(getProviderStats(key, dualAuthTypes(info, key)), info.noAuth),
    ),
    "oauth",
  );
  const freeEntries = Object.entries(FREE_PROVIDERS)
    .filter(
      ([key, info]) =>
        !info.hidden &&
        matchSearch(info.name) &&
        matchStatus(getProviderStats(key, dualAuthTypes(info, key)), info.noAuth),
    )
    .sort(([, a], [, b]) => (b.noAuth ? 1 : 0) - (a.noAuth ? 1 : 0));
  // Free Tier cards may be oauth-only (e.g. kimchi) or dual-auth, so count via
  // dualAuthTypes per provider instead of a fixed "apikey" — otherwise oauth
  // connections are invisible here (mismatch with the detail page).
  const freeTierEntries = Object.entries(FREE_TIER_PROVIDERS)
    .filter(
      ([key, info]) =>
        !info.hidden &&
        matchSearch(info.name) &&
        (info.serviceKinds ?? ["llm"]).includes("llm") &&
        matchStatus(getProviderStats(key, dualAuthTypes(info, key)), info.noAuth),
    )
    .sort(([ka, a], [kb, b]) => {
      const pa = a.priority ?? 999;
      const pb = b.priority ?? 999;
      if (pa !== pb) return pa - pb;
      const noAuthDiff = (b.noAuth ? 1 : 0) - (a.noAuth ? 1 : 0);
      if (noAuthDiff !== 0) return noAuthDiff;
      const ca = getProviderStats(ka, dualAuthTypes(a, ka)).connected > 0 ? 0 : 1;
      const cb = getProviderStats(kb, dualAuthTypes(b, kb)).connected > 0 ? 0 : 1;
      if (ca !== cb) return ca - cb;
      return (a.name || "").localeCompare(b.name || "");
    });
  // API Key: connected providers first, then alphabetical by name
  const apikeyEntries = Object.entries(APIKEY_PROVIDERS)
    .filter(
      ([key, info]) =>
        !info.hidden &&
        (info.serviceKinds ?? ["llm"]).includes("llm") &&
        matchSearch(info.name) &&
        matchStatus(getProviderStats(key, "apikey"), info.noAuth),
    )
    .sort(([ka, a], [kb, b]) => {
      const ca = getProviderStats(ka, "apikey").total > 0 ? 0 : 1;
      const cb = getProviderStats(kb, "apikey").total > 0 ? 0 : 1;
      if (ca !== cb) return ca - cb;
      return (a.name || "").localeCompare(b.name || "");
    });
  const isApikeySearching = !!searchQuery.trim() || statusFilter !== "all";

  // Split each section into providers that have connections (cards, on top)
  // and providers with none (one compact collapsible list per section).
  // noAuth providers are usable without connections, so they count as active.
  const splitEntries = (entries, statsFor) => {
    const connected = [];
    const empty = [];
    for (const entry of entries) {
      if (statsFor(entry).total > 0 || entry[1].noAuth) connected.push(entry);
      else empty.push(entry);
    }
    return [connected, empty];
  };
  const [oauthConnected, oauthEmpty] = splitEntries(oauthEntries, ([key, info]) =>
    getProviderStats(key, dualAuthTypes(info, key)),
  );
  const [freeConnected, freeEmpty] = splitEntries(freeEntries, ([key, info]) =>
    getProviderStats(key, dualAuthTypes(info, key)),
  );
  const [freeTierConnected, freeTierEmpty] = splitEntries(
    freeTierEntries,
    ([key, info]) => getProviderStats(key, dualAuthTypes(info, key)),
  );
  const [apikeyConnected, apikeyEmpty] = splitEntries(apikeyEntries, ([key]) =>
    getProviderStats(key, "apikey"),
  );

  // All Connection Providers — every provider that is currently ON, gathered
  // from all categories into one shelf at the top of the page. ON means: has
  // connections (or is noAuth-ready) and is not fully disabled. Providers keep
  // their home sections below; this shelf is the quick view of what is live.
  const allOnProviders = (() => {
    const seen = new Set();
    const list = [];
    const push = (providerId, provider, stats, authType, card, authTypes) => {
      if (seen.has(providerId)) return;
      if (!((stats.total > 0 || provider.noAuth) && !stats.allDisabled)) return;
      seen.add(providerId);
      list.push({ providerId, provider, stats, authType, card, authTypes });
    };
    for (const [key, info] of oauthConnected) {
      const authTypes = dualAuthTypes(info, key);
      push(key, info, getProviderStats(key, authTypes), "oauth", "provider", authTypes);
    }
    for (const [key, info] of freeConnected) {
      const authTypes = dualAuthTypes(info, key);
      push(key, info, getProviderStats(key, authTypes), "free", "provider", authTypes);
    }
    for (const [key, info] of freeTierConnected) {
      const authTypes = dualAuthTypes(info, key);
      push(key, info, getProviderStats(key, authTypes), Array.isArray(authTypes) ? (authTypes[0] ?? "apikey") : authTypes, "apikey", authTypes);
    }
    for (const [key, info] of apikeyConnected) {
      push(key, info, getProviderStats(key, "apikey"), "apikey", "apikey", "apikey");
    }
    for (const info of [...compatibleProviders, ...anthropicCompatibleProviders]) {
      push(info.id, info, getProviderStats(info.id, "apikey"), "compatible", "apikey", "apikey");
    }
    return list;
  })();

  // Web Cookie: providers authenticated by a pasted browser/session cookie
  // (connections are stored with authType "cookie" — see POST /api/providers).
  const webCookieEntries = Object.entries(WEB_COOKIE_PROVIDERS)
    .filter(
      ([key, info]) =>
        !info.hidden &&
        (info.serviceKinds ?? ["llm"]).includes("llm") &&
        matchSearch(info.name) &&
        matchStatus(getProviderStats(key, "cookie"), info.noAuth),
    )
    .sort(([ka, a], [kb, b]) => {
      const ca = getProviderStats(ka, "cookie").total > 0 ? 0 : 1;
      const cb = getProviderStats(kb, "cookie").total > 0 ? 0 : 1;
      if (ca !== cb) return ca - cb;
      return (a.name || "").localeCompare(b.name || "");
    });

  // P2-20: Load-more windowing for the card grids (24 per page). The window
  // resets whenever the search query or status filter changes, so a filtered
  // list never strands the user on an empty later page.
  const pageResetKey = `${searchQuery}|${statusFilter}`;
  const allOnPage = useVisibleCount(allOnProviders.length, pageResetKey);
  const customPage = useVisibleCount(
    compatibleProviders.length + anthropicCompatibleProviders.length,
    pageResetKey,
  );
  const oauthPage = useVisibleCount(oauthConnected.length, pageResetKey);
  const freePage = useVisibleCount(
    freeConnected.length + freeTierConnected.length,
    pageResetKey,
  );
  const apikeyPage = useVisibleCount(
    apikeyConnected.length + webCookieEntries.length,
    pageResetKey,
  );

  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const hasAnyResult =
    oauthEntries.length > 0 ||
    freeEntries.length > 0 ||
    freeTierEntries.length > 0 ||
    apikeyEntries.length > 0 ||
    webCookieEntries.length > 0 ||
    compatibleProviders.length > 0 ||
    anthropicCompatibleProviders.length > 0;

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <div className="flex items-center justify-between gap-3">
        <label
          className="flex cursor-pointer items-center gap-2 text-xs text-text-muted"
          title="Connections without their own proxy borrow one from the active proxy pools when tested (single Test and Test All). A failed borrowed proxy falls back to a direct test."
        >
          <Toggle checked={autoProxyForTests} onChange={toggleAutoProxyForTests} />
          Auto proxy for tests
        </label>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-8 rounded-[10px] border border-black/10 bg-black/[0.02] px-2 text-xs text-text-primary outline-none transition-colors hover:bg-black/5 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
          aria-label="Filter providers by connection status"
        >
          {STATUS_FILTER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <Button size="sm" variant="outline" icon="search" onClick={() => setShowCatalogSearch(true)}>
          Search catalogs
        </Button>
      </div>

      {!hasAnyResult && (
        <div className="text-center py-8 border border-dashed border-border rounded-xl">
          <span className="material-symbols-outlined text-[32px] text-text-muted mb-2">
            search_off
          </span>
          <p className="text-text-muted text-sm">
            No providers match your search or filters
          </p>
        </div>
      )}

      {/* Custom Providers (OpenAI/Anthropic Compatible) — dynamic */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg sm:text-xl font-semibold flex items-center gap-2 leading-tight">
            Custom Providers (OpenAI/Anthropic Compatible){" "}
          </h2>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:w-auto">
            <Button
              size="sm"
              icon="add"
              onClick={() => setShowAddAnthropicCompatibleModal(true)}
              className="w-full sm:w-auto"
            >
              <span className="sm:hidden">Add Anthropic</span>
              <span className="hidden sm:inline">Add Anthropic Compatible</span>
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon="add"
              onClick={() => setShowAddCompatibleModal(true)}
              className="w-full sm:w-auto"
            >
              <span className="sm:hidden">Add OpenAI</span>
              <span className="hidden sm:inline">Add OpenAI Compatible</span>
            </Button>
          </div>
        </div>
      </div>

      {/* All Connection Providers — everything currently ON */}
      {allOnProviders.length > 0 && (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg sm:text-xl font-semibold flex items-center gap-2 leading-tight">
            All Connection Providers
            <Badge variant="success" size="sm">{allOnProviders.length} on</Badge>
          </h2>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <button
              onClick={() =>
                testingMode === "all" ? handleStopBatchTest() : handleBatchTest("all")
              }
              disabled={!!testingMode && testingMode !== "all"}
              className={`flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors sm:w-auto sm:py-1.5 ${
                testingMode === "all"
                  ? "border-red-400/50 bg-red-500/10 text-red-500 hover:bg-red-500/20"
                  : "bg-surface-2 border-border text-text-main hover:border-primary/40 hover:text-primary"
              }`}
              title={testingMode === "all" ? "Stop the running test" : "Test all connections that are on"}
              aria-label={testingMode === "all" ? "Stop the running test" : "Test all connections that are on"}
            >
              <span
                className={`material-symbols-outlined text-[14px]${testingMode === "all" ? "" : " text-primary"}`}
              >
                {testingMode === "all" ? "stop_circle" : "play_arrow"}
              </span>
              {testingMode === "all" ? "Stop" : "Test All"}
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
          {allOnProviders.slice(0, allOnPage.visible).map((entry) => entry.card === "provider" ? (
            <ProviderCard
              key={`all-${entry.providerId}`}
              providerId={entry.providerId}
              provider={entry.provider}
              stats={entry.stats}
              authType={entry.authType}
              onToggle={(active) => handleToggleProvider(entry.providerId, entry.authTypes, active)}
            />
          ) : (
            <ApiKeyProviderCard
              key={`all-${entry.providerId}`}
              providerId={entry.providerId}
              provider={entry.provider}
              stats={entry.stats}
              authType={entry.authType}
              onToggle={(active) => handleToggleProvider(entry.providerId, entry.authTypes, active)}
            />
          ))}
        </div>
        {allOnPage.hasMore && (
          <button
            type="button"
            onClick={allOnPage.showMore}
            className="mt-2 w-full rounded-lg border border-dashed border-border px-3 py-2 text-sm text-text-muted transition-colors hover:border-brand-500 hover:text-brand-500"
          >
            {`Load more (${allOnPage.remaining} remaining)`}
          </button>
        )}
      </div>
      )}

      {/* Provider Custom — the custom providers added by the operator */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg sm:text-xl font-semibold flex items-center gap-2 leading-tight">
            Provider Custom
          </h2>
          {(compatibleProviders.length > 0 ||
            anthropicCompatibleProviders.length > 0) && (
            <button
              onClick={() =>
                testingMode === "compatible" ? handleStopBatchTest() : handleBatchTest("compatible")
              }
              disabled={!!testingMode && testingMode !== "compatible"}
              className={`flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors sm:w-auto sm:py-1.5 ${
                testingMode === "compatible"
                  ? "border-red-400/50 bg-red-500/10 text-red-500 hover:bg-red-500/20"
                  : "bg-surface-2 border-border text-text-main hover:border-primary/40 hover:text-primary"
              }`}
              title={testingMode === "compatible" ? "Stop the running test" : "Test all custom provider connections"}
              aria-label={testingMode === "compatible" ? "Stop the running test" : "Test all custom provider connections"}
            >
              <span
                className={`material-symbols-outlined text-[14px]${testingMode === "compatible" ? "" : " text-primary"}`}
              >
                {testingMode === "compatible" ? "stop_circle" : "play_arrow"}
              </span>
              {testingMode === "compatible" ? "Stop" : "Test All"}
            </button>
          )}
        </div>
        {compatibleProviders.length === 0 &&
        anthropicCompatibleProviders.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-2 border border-dashed border-border rounded-xl text-text-muted text-sm">
            <span className="material-symbols-outlined text-[18px]">extension</span>
            <span>No custom providers — use buttons above to add OpenAI/Anthropic compatible endpoints</span>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
              {[...compatibleProviders, ...anthropicCompatibleProviders].slice(0, customPage.visible).map(
                (info) => (
                  <ApiKeyProviderCard
                    key={info.id}
                    providerId={info.id}
                    provider={info}
                    stats={getProviderStats(info.id, "apikey")}
                    authType="compatible"
                    onToggle={(active) =>
                      handleToggleProvider(info.id, "apikey", active)
                    }
                  />
                ),
              )}
            </div>
            {customPage.hasMore && (
              <button
                type="button"
                onClick={customPage.showMore}
                className="mt-2 w-full rounded-lg border border-dashed border-border px-3 py-2 text-sm text-text-muted transition-colors hover:border-brand-500 hover:text-brand-500"
              >
                {`Load more (${customPage.remaining} remaining)`}
              </button>
            )}
          </>
        )}
      </div>

      {/* OAuth Providers */}
      {oauthEntries.length > 0 && (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg sm:text-xl font-semibold flex items-center gap-2 leading-tight">
            OAuth Providers
          </h2>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <ModelAvailabilityBadge />
            <button
              onClick={() =>
                testingMode === "oauth" ? handleStopBatchTest() : handleBatchTest("oauth")
              }
              disabled={!!testingMode && testingMode !== "oauth"}
              className={`flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors sm:w-auto sm:py-1.5 ${
                testingMode === "oauth"
                  ? "border-red-400/50 bg-red-500/10 text-red-500 hover:bg-red-500/20"
                  : "bg-surface-2 border-border text-text-main hover:border-primary/40 hover:text-primary"
              }`}
              title={testingMode === "oauth" ? "Stop the running test" : "Test all OAuth connections"}
              aria-label={testingMode === "oauth" ? "Stop the running test" : "Test all OAuth connections"}
            >
              <span
                className={`material-symbols-outlined text-[14px]${testingMode === "oauth" ? "" : " text-primary"}`}
              >
                {testingMode === "oauth" ? "stop_circle" : "play_arrow"}
              </span>
              {testingMode === "oauth" ? "Stop" : "Test All"}
            </button>
          </div>
        </div>
        {oauthConnected.length > 0 && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
            {oauthConnected.slice(0, oauthPage.visible).map(([key, info]) => {
              const authTypes = dualAuthTypes(info, key);
              return (
                <ProviderCard
                  key={key}
                  providerId={key}
                  provider={info}
                  stats={getProviderStats(key, authTypes)}
                  authType="oauth"
                  onToggle={(active) => handleToggleProvider(key, authTypes, active)}
                />
              );
            })}
          </div>
          {oauthPage.hasMore && (
            <button
              type="button"
              onClick={oauthPage.showMore}
              className="mt-2 w-full rounded-lg border border-dashed border-border px-3 py-2 text-sm text-text-muted transition-colors hover:border-brand-500 hover:text-brand-500"
            >
              {`Load more (${oauthPage.remaining} remaining)`}
            </button>
          )}
        </>
        )}
        <NotConnectedProviders entries={oauthEmpty} forceOpen={isApikeySearching} />
      </div>
      )}

      {/* Free Tier Providers */}
      {(freeEntries.length > 0 || freeTierEntries.length > 0) && (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg sm:text-xl font-semibold flex items-center gap-2 leading-tight">
            Free Tier Providers
          </h2>
          <button
            onClick={() =>
              testingMode === "free" ? handleStopBatchTest() : handleBatchTest("free")
            }
            disabled={!!testingMode && testingMode !== "free"}
            className={`flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors sm:w-auto sm:py-1.5 ${
              testingMode === "free"
                ? "border-red-400/50 bg-red-500/10 text-red-500 hover:bg-red-500/20"
                : "bg-surface-2 border-border text-text-main hover:border-primary/40 hover:text-primary"
            }`}
            title={testingMode === "free" ? "Stop the running test" : "Test all Free connections"}
            aria-label={testingMode === "free" ? "Stop the running test" : "Test all Free provider connections"}
          >
            <span
              className={`material-symbols-outlined text-[14px]${testingMode === "free" ? "" : " text-primary"}`}
            >
              {testingMode === "free" ? "stop_circle" : "play_arrow"}
            </span>
            {testingMode === "free" ? "Stop" : "Test All"}
          </button>
        </div>
        {(freeConnected.length > 0 || freeTierConnected.length > 0) && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
            {[...freeConnected.map(([key, info]) => ({ card: "provider", key, info })),
              ...freeTierConnected.map(([key, info]) => ({ card: "apikey", key, info }))]
              .slice(0, freePage.visible).map((entry) => {
                const { key, info } = entry;
                // Dual-auth (e.g. kiro): count/toggle oauth + apikey/api_key so the
                // card total matches the provider detail page.
                const freeAuthTypes = dualAuthTypes(info, key);
                return entry.card === "provider" ? (
                  <ProviderCard
                    key={key}
                    providerId={key}
                    provider={info}
                    stats={getProviderStats(key, freeAuthTypes)}
                    authType="free"
                    onToggle={(active) =>
                      handleToggleProvider(key, freeAuthTypes, active)
                    }
                  />
                ) : (
                  <ApiKeyProviderCard
                    key={key}
                    providerId={key}
                    provider={info}
                    stats={getProviderStats(key, freeAuthTypes)}
                    authType={Array.isArray(freeAuthTypes) ? (freeAuthTypes[0] ?? "apikey") : freeAuthTypes}
                    onToggle={(active) => handleToggleProvider(key, freeAuthTypes, active)}
                  />
                );
              })}
          </div>
          {freePage.hasMore && (
            <button
              type="button"
              onClick={freePage.showMore}
              className="mt-2 w-full rounded-lg border border-dashed border-border px-3 py-2 text-sm text-text-muted transition-colors hover:border-brand-500 hover:text-brand-500"
            >
              {`Load more (${freePage.remaining} remaining)`}
            </button>
          )}
        </>
        )}
        <NotConnectedProviders
          entries={[...freeEmpty, ...freeTierEmpty]}
          forceOpen={isApikeySearching}
        />
      </div>
      )}

      {/* API Key Providers — fixed list */}
      {apikeyEntries.length > 0 && (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg sm:text-xl font-semibold flex items-center gap-2 leading-tight">
            API Key Providers{" "}
          </h2>
          <button
            onClick={() =>
              testingMode === "apikey" ? handleStopBatchTest() : handleBatchTest("apikey")
            }
            disabled={!!testingMode && testingMode !== "apikey"}
            className={`flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors sm:w-auto sm:py-1.5 ${
              testingMode === "apikey"
                ? "border-red-400/50 bg-red-500/10 text-red-500 hover:bg-red-500/20"
                : "bg-surface-2 border-border text-text-main hover:border-primary/40 hover:text-primary"
            }`}
            title={testingMode === "apikey" ? "Stop the running test" : "Test all API Key connections"}
            aria-label={testingMode === "apikey" ? "Stop the running test" : "Test all API Key connections"}
          >
            <span
              className={`material-symbols-outlined text-[14px]${testingMode === "apikey" ? "" : " text-primary"}`}
            >
              {testingMode === "apikey" ? "stop_circle" : "play_arrow"}
            </span>
            {testingMode === "apikey" ? "Stop" : "Test All"}
          </button>
        </div>
        {apikeyConnected.length > 0 && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
            {[...apikeyConnected.map(([key, info]) => ({ authType: "apikey", key, info })),
              ...webCookieEntries.map(([key, info]) => ({ authType: "cookie", key, info }))]
              .slice(0, apikeyPage.visible).map(({ authType, key, info }) => (
                <ApiKeyProviderCard
                  key={key}
                  providerId={key}
                  provider={info}
                  stats={getProviderStats(key, authType)}
                  authType={authType}
                  onToggle={(active) => handleToggleProvider(key, authType, active)}
                />
              ))}
          </div>
          {apikeyPage.hasMore && (
            <button
              type="button"
              onClick={apikeyPage.showMore}
              className="mt-2 w-full rounded-lg border border-dashed border-border px-3 py-2 text-sm text-text-muted transition-colors hover:border-brand-500 hover:text-brand-500"
            >
              {`Load more (${apikeyPage.remaining} remaining)`}
            </button>
          )}
        </>
        )}
        <NotConnectedProviders entries={apikeyEmpty} forceOpen={isApikeySearching} />
      </div>
      )}

      {/* R10 cross-provider catalog search */}
      <CatalogSearchModal isOpen={showCatalogSearch} onClose={() => setShowCatalogSearch(false)} />
      <AddCompatibleModal
        variant="openai"
        isOpen={showAddCompatibleModal}
        onClose={() => setShowAddCompatibleModal(false)}
        onCreated={(node) => {
          setProviderNodes((prev) => [...prev, node]);
          setShowAddCompatibleModal(false);
        }}
      />
      <AddCompatibleModal
        variant="anthropic"
        isOpen={showAddAnthropicCompatibleModal}
        onClose={() => setShowAddAnthropicCompatibleModal(false)}
        onCreated={(node) => {
          setProviderNodes((prev) => [...prev, node]);
          setShowAddAnthropicCompatibleModal(false);
        }}
      />

      {/* Test Results Modal */}
      {testResults && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center px-3 pt-[6vh] sm:pt-[10vh]"
          onClick={() => setTestResults(null)}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div
            className="relative bg-surface border border-border rounded-xl w-full max-w-[600px] max-h-[86vh] sm:max-h-[80vh] overflow-y-auto shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-3 border-b border-border bg-surface/95 backdrop-blur-sm rounded-t-xl">
              <h3 className="font-semibold">Test Results</h3>
              <button
                onClick={() => setTestResults(null)}
                className="p-2 rounded-lg hover:bg-bg text-text-muted hover:text-text-main transition-colors"
                aria-label="Close test results"
              >
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            </div>
            <div className="p-5">
              <ProviderTestResultsView results={testResults} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ProviderCard({ providerId, provider, stats, authType, onToggle }) {
  const { connected, error, errorCode, errorTime, allDisabled, breaker } = stats;
  const isNoAuth = !!provider.noAuth;

  const dotColors = {
    free: "bg-green-500",
    oauth: "bg-blue-500",
    apikey: "bg-amber-500",
    compatible: "bg-orange-500",
  };
  const dotLabels = {
    free: "Free",
    oauth: "OAuth",
    apikey: "API Key",
    compatible: "Compatible",
  };

  return (
    <Link href={`/dashboard/providers/${providerId}`} className="group min-w-0">
      <Card
        padding="xs"
        className={`h-full hover:bg-black/[0.01] dark:hover:bg-white/[0.01] transition-colors cursor-pointer ${allDisabled ? "opacity-50" : ""}`}
      >
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div
              className="size-8 shrink-0 rounded-lg flex items-center justify-center"
              style={{
                backgroundColor: `${provider.color?.length > 7 ? provider.color : provider.color + "15"}`,
              }}
            >
              <ProviderIcon
                src={`/providers/${provider.id}.png`}
                alt={provider.name}
                size={30}
                className="object-contain rounded-lg max-w-[32px] max-h-[32px]"
                fallbackText={
                  provider.textIcon || provider.id.slice(0, 2).toUpperCase()
                }
                fallbackColor={provider.color}
                detectBaseUrl={provider.baseUrl}
              />
            </div>
            <div className="min-w-0">
              <h3 className="truncate font-semibold">{provider.name}</h3>
              <div className="flex min-w-0 items-center gap-1.5 text-xs flex-wrap">
                {allDisabled ? (
                  <Badge variant="default" size="sm">
                    <span className="flex items-center gap-1">
                      <span className="material-symbols-outlined text-[12px]">
                        pause_circle
                      </span>
                      Disabled
                    </span>
                  </Badge>
                ) : isNoAuth ? (
                  <Badge variant="success" size="sm" dot>Ready</Badge>
                ) : (
                  <>
                    {getStatusDisplay(connected, error, errorCode)}
                    {breaker?.state === "open" && (
                      <span title="Provider breaker open — broad failures, no traffic until the probe window.">
                        <Badge variant="error" size="sm">
                          Breaker open
                        </Badge>
                      </span>
                    )}
                    {breaker?.state === "half-open" && (
                      <span title="Provider breaker probing — traffic resumes, one failure re-opens it.">
                        <Badge variant="warning" size="sm">
                          Breaker probing
                        </Badge>
                      </span>
                    )}
                    {breaker?.state === "closed" && (breaker?.failuresInWindow || 0) > 0 && (
                      <span title="Provider breaker pre-trip — recent failures in the window, still serving. It opens after repeated failures from multiple connections.">
                        <Badge variant="default" size="sm">
                          Breaker watching ({breaker.failuresInWindow})
                        </Badge>
                      </span>
                    )}
                    {errorTime && (
                      <span className="text-text-muted">{errorTime}</span>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {stats.total > 0 && (
              <div
                className="transition-opacity"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onToggle(!allDisabled ? false : true);
                }}
              >
                <Toggle
                  size="sm"
                  checked={!allDisabled}
                  onChange={() => {}}
                  title={allDisabled ? "Enable provider" : "Disable provider"}
                />
              </div>
            )}
          </div>
        </div>
      </Card>
    </Link>
  );
}

ProviderCard.propTypes = {
  providerId: PropTypes.string.isRequired,
  provider: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    color: PropTypes.string,
    textIcon: PropTypes.string,
  }).isRequired,
  stats: PropTypes.shape({
    connected: PropTypes.number,
    error: PropTypes.number,
    errorCode: PropTypes.string,
    errorTime: PropTypes.string,
  }).isRequired,
  authType: PropTypes.string,
  onToggle: PropTypes.func,
};

function ApiKeyProviderCard({
  providerId,
  provider,
  stats,
  authType,
  onToggle,
}) {
  const { connected, error, errorCode, errorTime, allDisabled, breaker } = stats;
  const isCompatible = providerId.startsWith(OPENAI_COMPATIBLE_PREFIX);
  const isAnthropicCompatible = providerId.startsWith(
    ANTHROPIC_COMPATIBLE_PREFIX,
  );

  const dotColors = {
    free: "bg-green-500",
    oauth: "bg-blue-500",
    apikey: "bg-amber-500",
    compatible: "bg-orange-500",
  };
  const dotLabels = {
    free: "Free",
    oauth: "OAuth",
    apikey: "API Key",
    compatible: "Compatible",
  };

  const getIconPath = () => {
    if (isCompatible && provider.apiType)
      return provider.apiType === "responses"
        ? "/providers/oai-r.png"
        : "/providers/oai-cc.png";
    if (isAnthropicCompatible) return "/providers/anthropic-m.png";
    return getProviderIconSrc(provider.id);
  };

  return (
    <Link href={`/dashboard/providers/${providerId}`} className="group min-w-0">
      <Card
        padding="xs"
        className={`h-full hover:bg-black/[0.01] dark:hover:bg-white/[0.01] transition-colors cursor-pointer ${allDisabled ? "opacity-50" : ""}`}
      >
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div
              className="size-8 shrink-0 rounded-lg flex items-center justify-center"
              style={{
                backgroundColor: `${provider.color?.length > 7 ? provider.color : provider.color + "15"}`,
              }}
            >
              <ProviderIcon
                src={getIconPath()}
                alt={provider.name}
                size={30}
                className="object-contain rounded-lg max-w-[30px] max-h-[30px]"
                fallbackText={
                  provider.textIcon || provider.id.slice(0, 2).toUpperCase()
                }
                fallbackColor={provider.color}
              />
            </div>
            <div className="min-w-0">
              <h3 className="truncate font-semibold">{provider.name}</h3>
              <div className="flex min-w-0 items-center gap-1.5 text-xs flex-wrap">
                {allDisabled ? (
                  <Badge variant="default" size="sm">
                    <span className="flex items-center gap-1">
                      <span className="material-symbols-outlined text-[12px]">
                        pause_circle
                      </span>
                      Disabled
                    </span>
                  </Badge>
                ) : (
                  <>
                    {getStatusDisplay(connected, error, errorCode)}
                    {breaker?.state === "open" && (
                      <span title="Provider breaker open — broad failures, no traffic until the probe window.">
                        <Badge variant="error" size="sm">
                          Breaker open
                        </Badge>
                      </span>
                    )}
                    {breaker?.state === "half-open" && (
                      <span title="Provider breaker probing — traffic resumes, one failure re-opens it.">
                        <Badge variant="warning" size="sm">
                          Breaker probing
                        </Badge>
                      </span>
                    )}
                    {breaker?.state === "closed" && (breaker?.failuresInWindow || 0) > 0 && (
                      <span title="Provider breaker pre-trip — recent failures in the window, still serving. It opens after repeated failures from multiple connections.">
                        <Badge variant="default" size="sm">
                          Breaker watching ({breaker.failuresInWindow})
                        </Badge>
                      </span>
                    )}
                    {isCompatible && (
                      <Badge variant="default" size="sm">
                        {provider.apiType === "responses"
                          ? "Responses"
                          : "Chat"}
                      </Badge>
                    )}
                    {isAnthropicCompatible && (
                      <Badge variant="default" size="sm">
                        Messages
                      </Badge>
                    )}
                    {errorTime && (
                      <span className="text-text-muted">{errorTime}</span>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {stats.total > 0 && (
              <div
                className="transition-opacity"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onToggle(!allDisabled ? false : true);
                }}
              >
                <Toggle
                  size="sm"
                  checked={!allDisabled}
                  onChange={() => {}}
                  title={allDisabled ? "Enable provider" : "Disable provider"}
                />
              </div>
            )}
          </div>
        </div>
      </Card>
    </Link>
  );
}

ApiKeyProviderCard.propTypes = {
  providerId: PropTypes.string.isRequired,
  provider: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    color: PropTypes.string,
    textIcon: PropTypes.string,
    apiType: PropTypes.string,
  }).isRequired,
  stats: PropTypes.shape({
    connected: PropTypes.number,
    error: PropTypes.number,
    errorCode: PropTypes.string,
    errorTime: PropTypes.string,
  }).isRequired,
  authType: PropTypes.string,
  onToggle: PropTypes.func,
};

function ProviderTestResultsView({ results }) {
  if (results.error && !results.results) {
    return (
      <div className="text-center py-6">
        <span className="material-symbols-outlined text-red-500 text-[32px] mb-2 block">
          error
        </span>
        <p className="text-sm text-red-400">{results.error}</p>
      </div>
    );
  }

  const { summary, mode } = results;
  const items = results.results || [];
  const modeLabel =
    {
      oauth: "OAuth",
      free: "Free",
      apikey: "API Key",
      provider: "Provider",
      all: "All",
    }[mode] || mode;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {summary && (
        <div className="flex flex-wrap items-center gap-2 text-xs mb-1 sm:gap-3">
          <span className="text-text-muted">{modeLabel} Test</span>
          <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-medium">
            {summary.passed} passed
          </span>
          {summary.failed > 0 && (
            <span className="px-2 py-0.5 rounded bg-red-500/15 text-red-400 font-medium">
              {summary.failed} failed
            </span>
          )}
          <span className="text-text-muted sm:ml-auto">
            {summary.total} tested
          </span>
        </div>
      )}
      {items.map((r, i) => (
        <div
          key={r.connectionId || i}
          className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg bg-black/[0.03] px-3 py-2 text-xs dark:bg-white/[0.03] sm:flex-nowrap"
        >
          <span
            className={`material-symbols-outlined text-[16px] ${r.valid ? "text-emerald-500" : "text-red-500"}`}
          >
            {r.valid ? "check_circle" : "error"}
          </span>
          <div className="min-w-0 flex-[1_1_160px]">
            <span className="block truncate font-medium sm:inline">
              {r.connectionName}
            </span>
            <span className="block truncate text-text-muted sm:ml-1.5 sm:inline">
              ({r.provider})
            </span>
          </div>
          {r.latencyMs !== undefined && (
            <span className="shrink-0 text-text-muted font-mono tabular-nums">
              {r.latencyMs}ms
            </span>
          )}
          <span
            className={`shrink-0 text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${
              r.valid
                ? "bg-emerald-500/15 text-emerald-400"
                : "bg-red-500/15 text-red-400"
            }`}
          >
            {r.valid ? "OK" : r.diagnosis?.type || "ERROR"}
          </span>
        </div>
      ))}
      {items.length === 0 && (
        <div className="text-center py-4 text-text-muted text-sm">
          No active connections found for this group.
        </div>
      )}
    </div>
  );
}

ProviderTestResultsView.propTypes = {
  results: PropTypes.shape({
    mode: PropTypes.string,
    results: PropTypes.array,
    summary: PropTypes.shape({
      total: PropTypes.number,
      passed: PropTypes.number,
      failed: PropTypes.number,
    }),
    error: PropTypes.string,
  }).isRequired,
};
