"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import PropTypes from "prop-types";
import ProviderIcon from "@/shared/components/ProviderIcon";
import HeaderMenu from "@/shared/components/HeaderMenu";
import DonateModal from "@/shared/components/DonateModal";
import { Modal, Input, Button } from "@/shared/components";
import { getNameFontStyle, DEFAULT_NAME } from "@/shared/constants/nameStyles";
import { cn } from "@/shared/utils/cn";
import { useHeaderSearchStore, isHeaderSearchPath } from "@/store/headerSearchStore";
import { OAUTH_PROVIDERS, APIKEY_PROVIDERS } from "@/shared/constants/config";
import { MEDIA_PROVIDER_KINDS, AI_PROVIDERS } from "@/shared/constants/providers";
import { getProviderIconSrc } from "@/shared/utils/providerIcon";
import { translate } from "@/i18n/runtime";

const getPageInfo = (pathname) => {
  if (!pathname) return { title: "", description: "", breadcrumbs: [] };

  // Media provider detail: /dashboard/media-providers/[kind]/[id]
  const mediaDetailMatch = pathname.match(/\/media-providers\/([^/]+)\/([^/]+)$/);
  if (mediaDetailMatch) {
    const kindId = mediaDetailMatch[1];
    const providerId = mediaDetailMatch[2];
    const kindConfig = MEDIA_PROVIDER_KINDS.find((k) => k.id === kindId);
    const provider = AI_PROVIDERS[providerId];
    return {
      title: provider?.name || providerId,
      description: "",
      breadcrumbs: [
        { label: "Media Providers", href: `/dashboard/media-providers/${kindId}` },
        { label: kindConfig?.label || kindId, href: `/dashboard/media-providers/${kindId}` },
        { label: provider?.name || providerId, image: getProviderIconSrc(providerId) },
      ],
    };
  }

  // Media provider kind: /dashboard/media-providers/[kind]
  const mediaKindMatch = pathname.match(/\/media-providers\/([^/]+)$/);
  if (mediaKindMatch) {
    const kindId = mediaKindMatch[1];
    const kindConfig = MEDIA_PROVIDER_KINDS.find((k) => k.id === kindId);
    return {
      title: kindConfig?.label || kindId,
      description: `Manage your ${kindConfig?.label || kindId} providers`,
      icon: kindConfig?.icon || "perm_media",
      breadcrumbs: [],
    };
  }

  // Provider detail page: /dashboard/providers/[id]
  const providerMatch = pathname.match(/\/providers\/([^/]+)$/);
  if (providerMatch) {
    const providerId = providerMatch[1];
    const providerInfo =
      OAUTH_PROVIDERS[providerId] || APIKEY_PROVIDERS[providerId];
    if (providerInfo) {
      return {
        title: providerInfo.name,
        description: "",
        breadcrumbs: [
          { label: "Providers", href: "/dashboard/providers" },
          {
            label: providerInfo.name,
            image: getProviderIconSrc(providerInfo.id),
          },
        ],
      };
    }
  }

  if (pathname.includes("/providers") && !pathname.includes("/media-providers"))
    return {
      title: "Providers",
      description: "Manage your AI provider connections",
      icon: "dns",
      breadcrumbs: [],
    };
  if (pathname.includes("/combos"))
    return {
      title: "Combos",
      description: "Model combos with fallback",
      icon: "layers",
      breadcrumbs: [],
    };
  if (pathname.includes("/usage"))
    return {
      title: "Usage",
      description:
        "Monitor your API usage, token consumption, and request logs",
      icon: "bar_chart",
      breadcrumbs: [],
    };
  if (pathname.includes("/auth-files"))
    return {
      title: "Auth Files",
      description: "Map provider credentials stored in the local database",
      icon: "vpn_key",
      breadcrumbs: [],
    };
  if (pathname.includes("/quota"))
    return {
      title: "Provider Quota",
      description: "Provider-side quota balances per connection",
      icon: "data_usage",
      breadcrumbs: [],
    };
  if (pathname.includes("/mitm"))
    return {
      title: "MITM Proxy",
      description: "Intercept CLI tool traffic and route through 9Router",
      icon: "security",
      breadcrumbs: [],
    };
  if (pathname.includes("/token-saver"))
    return {
      title: "Token Saver",
      description: "Compress prompts and outputs to save tokens",
      icon: "savings",
      breadcrumbs: [],
    };
  if (pathname.includes("/prompt-injection"))
    return {
      title: "Prompt Injection",
      description: "Attach prompts to models, combos, keys, or every request",
      icon: "skull",
      breadcrumbs: [],
    };
  if (pathname.includes("/cli-tools"))
    return {
      title: "CLI Tools",
      description: "Configure CLI tools",
      icon: "terminal",
      breadcrumbs: [],
    };
  if (pathname.includes("/proxy-pools"))
    return {
      title: "Proxy Pools",
      description: "Manage your proxy pool configurations",
      icon: "lan",
      breadcrumbs: [],
    };
  if (pathname.includes("/skills"))
    return {
      title: "Skills",
      description: "Copy a link and paste to your AI to use 9Router — no install needed",
      icon: "extension",
      breadcrumbs: [],
    };
  if (pathname.includes("/endpoint"))
    return {
      title: "Endpoint",
      description: "API endpoint configuration",
      icon: "api",
      breadcrumbs: [],
    };
  if (pathname.includes("/profile"))
    return {
      title: "Profile & Settings",
      description: "Manage your profile and preferences",
      icon: "settings",
      breadcrumbs: [],
    };
  if (pathname.includes("/translator"))
    return {
      title: "Translator (debug)",
      description: "Debug translation flow between formats",
      icon: "translate",
      breadcrumbs: [],
    };
  if (pathname.includes("/console-log"))
    return {
      title: "Console Log",
      description: "Live server console output",
      icon: "monitor",
      breadcrumbs: [],
    };
  if (pathname.includes("/automation"))
    return {
      title: "Automation",
      description: "Notifications, response cache, two-factor authentication, and database maintenance",
      icon: "tune",
      breadcrumbs: [],
    };
  if (pathname.includes("/basic-chat"))
    return {
      title: "Basic Chat",
      description: "Chat directly through the router",
      icon: "chat",
      breadcrumbs: [],
    };
  if (pathname.includes("/pxpipe"))
    return {
      title: "PxPipe",
      description: "Prompt compression dashboard and savings",
      icon: "image",
      breadcrumbs: [],
    };

  if (pathname === "/dashboard")
    return {
      title: "Dashboard",
      description: "At-a-glance health, usage, keys, and combos",
      icon: "dashboard",
      breadcrumbs: [],
    };
  return { title: "", description: "", breadcrumbs: [] };
};

export default function Header({ onMenuClick, showMenuButton = true }) {
  const pathname = usePathname();
  const [displayName, setDisplayName] = useState("");
  const [loginMethod, setLoginMethod] = useState("");
  const [donateOpen, setDonateOpen] = useState(false);

  // 9Router Pro: personal display name where the theme/accent icon buttons
  // used to sit (those moved into the header menu). Accent-colored text in a
  // fixed handwriting style, click to edit the name. Persisted server-side
  // in settings (profileName) so it follows the user across devices.
  const [profileName, setProfileName] = useState(DEFAULT_NAME);
  const [nameOpen, setNameOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [savingName, setSavingName] = useState(false);

  // Memoize page info to prevent unnecessary recalculations
  const pageInfo = useMemo(() => getPageInfo(pathname), [pathname]);
  const { title, description, icon, breadcrumbs } = pageInfo;

  useEffect(() => {
    let cancelled = false;

    async function loadAuthStatus() {
      try {
        const res = await fetch("/api/auth/status", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          setDisplayName(data?.displayName || data?.samlName || data?.samlEmail || data?.oidcName || data?.oidcEmail || "");
          setLoginMethod(data?.loginMethod || "");
        }
      } catch {
        if (!cancelled) {
          setDisplayName("");
          setLoginMethod("");
        }
      }
    }

    loadAuthStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/settings", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (typeof data?.profileName === "string" && data.profileName.trim()) {
          setProfileName(data.profileName.trim());
        }
      } catch { /* keep defaults */ }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const openNameEditor = () => {
    setNameDraft(profileName);
    setNameOpen(true);
  };

  const saveName = async () => {
    const next = nameDraft.trim() || DEFAULT_NAME;
    setSavingName(true);
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileName: next }),
      });
      setProfileName(next);
      setNameOpen(false);
    } catch (err) {
      console.error("Failed to save display name:", err);
    }
    setSavingName(false);
  };

  const handleLogout = async () => {
    try {
      const res = await fetch("/api/auth/logout", { method: "POST" });
      if (res.ok) {
        window.location.assign("/login");
      }
    } catch (err) {
      console.error("Failed to logout:", err);
    }
  };

  return (
    <header className="shrink-0 flex items-center justify-between gap-3 px-4 lg:px-8 pt-3 pb-2 border-b border-border-subtle bg-surface/60 backdrop-blur-xl lg:bg-transparent lg:backdrop-blur-none z-20">
      {/* Mobile menu button */}
      <div className="flex items-center gap-3 lg:hidden shrink-0">
        {showMenuButton && (
          <button
            onClick={onMenuClick}
            className="text-text-main hover:text-primary transition-colors"
          >
            <span className="material-symbols-outlined">menu</span>
          </button>
        )}
      </div>

      {/* Page title with breadcrumbs */}
      <div className="flex flex-col min-w-0 flex-1">
        {breadcrumbs.length > 0 ? (
          <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
            {breadcrumbs.map((crumb, index) => (
              <div
                key={`${crumb.label}-${crumb.href || "current"}`}
                className={`items-center gap-1.5 sm:gap-2 min-w-0 ${
                  index < breadcrumbs.length - 1 ? "hidden sm:flex shrink-0" : "flex flex-1"
                }`}
              >
                {index > 0 && (
                  <span className="material-symbols-outlined text-text-muted text-base hidden sm:inline">
                    chevron_right
                  </span>
                )}
                {crumb.href ? (
                  <Link
                    href={crumb.href}
                    className="text-text-muted hover:text-primary transition-colors truncate"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                    {crumb.image && (
                      <ProviderIcon
                        src={crumb.image}
                        alt={crumb.label}
                        size={28}
                        className="object-contain rounded max-w-[24px] max-h-[24px] sm:max-w-[28px] sm:max-h-[28px] shrink-0"
                        fallbackText={crumb.label.slice(0, 2).toUpperCase()}
                      />
                    )}
                    <h1 className="text-base lg:text-2xl font-semibold text-text-main tracking-tight truncate">
                      {translate(crumb.label)}
                    </h1>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : title ? (
          <div>
            <div className="flex items-center gap-2">
              {icon && (
                <span className="material-symbols-outlined text-primary text-xl lg:text-2xl">
                  {icon}
                </span>
              )}
              <h1 className="text-base lg:text-2xl font-semibold tracking-tight truncate">
                {translate(title)}
              </h1>
            </div>
            {description && (
              <p className="hidden lg:block text-sm text-text-muted truncate">
                {translate(description)}
              </p>
            )}
          </div>
        ) : null}
      </div>

      {/* Right actions */}
      <div className="flex items-center gap-1 shrink-0">
        {displayName && (loginMethod === "OIDC" || loginMethod === "SAML") && (
          <div
            className="hidden sm:flex items-center max-w-[220px] px-3 py-1.5 rounded-full border border-border bg-surface/70 text-xs text-text-muted truncate"
            title={displayName}
          >
            <span className="material-symbols-outlined text-[14px] mr-1.5 text-primary">person</span>
            <span className="truncate">{displayName}</span>
            <span className="ml-2 shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
              {loginMethod}
            </span>
          </div>
        )}
        <HeaderSearch />
        <button
          onClick={() => setDonateOpen(true)}
          className="hidden sm:flex items-center gap-1.5 px-3 h-8 rounded-lg border border-pink-500/30 bg-pink-500/10 text-pink-600 dark:text-pink-400 hover:bg-pink-500/20 transition-colors text-sm font-medium"
          aria-label="Donate"
        >
          <span className="material-symbols-outlined text-[18px]">volunteer_activism</span>
          <span className="hidden sm:inline">Donate</span>
        </button>
        <button
          onClick={openNameEditor}
          className="max-w-[110px] cursor-pointer truncate px-1 text-[15px] leading-6 text-primary transition-opacity hover:opacity-75 sm:max-w-[180px]"
          style={getNameFontStyle("caveat")}
          title="Click to customize your name"
        >
          {profileName}
        </button>
        <HeaderMenu onLogout={handleLogout} />
      </div>
      <DonateModal isOpen={donateOpen} onClose={() => setDonateOpen(false)} />
      <Modal isOpen={nameOpen} onClose={() => setNameOpen(false)} title="Customize your name" size="xs" bodyClassName="p-4">
        <div className="flex flex-col gap-2.5">
          <Input
            label="Name"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            placeholder={DEFAULT_NAME}
            maxLength={24}
          />
          <p style={getNameFontStyle("caveat")} className="truncate px-0.5 text-xl text-primary">
            {nameDraft.trim() || DEFAULT_NAME}
          </p>
          <div className="flex gap-2">
            <Button onClick={saveName} fullWidth disabled={savingName}>
              {savingName ? "Saving…" : "Save"}
            </Button>
            <Button onClick={() => setNameOpen(false)} variant="ghost" fullWidth>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
    </header>
  );
}

function HeaderSearch() {
  const visible = useHeaderSearchStore((s) => s.visible);
  const query = useHeaderSearchStore((s) => s.query);
  const placeholder = useHeaderSearchStore((s) => s.placeholder);
  const setQuery = useHeaderSearchStore((s) => s.setQuery);
  const pathname = usePathname();
  // On mobile the field collapses to an icon so the page title keeps its
  // room; tapping the icon expands the field (and the X collapses it back).
  const [mobileOpen, setMobileOpen] = useState(false);

  // Scoped to Providers (P2-19): the query is consumed only there, so the
  // box must never render on Combos/Usage/Proxy Pools/etc. even if a stale
  // registration leaves `visible` true across a navigation.
  if (!visible || !isHeaderSearchPath(pathname)) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        aria-label="Search"
        className={cn(
          "flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-text-muted transition-colors hover:bg-black/5 hover:text-text-main dark:hover:bg-white/10 sm:hidden",
          mobileOpen && "hidden"
        )}
      >
        <span className="material-symbols-outlined text-[20px]">search</span>
      </button>
      <div className={cn("relative w-[160px] sm:w-[220px]", !mobileOpen && "hidden sm:block")}>
        <span className="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-text-muted text-[16px] pointer-events-none">
          search
        </span>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          aria-label="Search providers"
          title="Searches providers only"
          autoFocus={mobileOpen}
          className="w-full h-8 pl-7 pr-7 rounded-lg border border-border bg-surface/60 text-sm focus:outline-none focus:border-primary/50 transition-colors"
        />
        {(query || mobileOpen) && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setMobileOpen(false);
            }}
            className="absolute right-1 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-main p-0.5 rounded"
            aria-label="Clear search"
          >
            <span className="material-symbols-outlined text-[16px]">close</span>
          </button>
        )}
      </div>
    </>
  );
}

Header.propTypes = {
  onMenuClick: PropTypes.func,
  showMenuButton: PropTypes.bool,
};
