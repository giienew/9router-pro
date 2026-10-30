"use client";

import { useParams, notFound } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Card, Badge, Button, Toggle, AddCustomEmbeddingModal } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import { useProviderSummary } from "@/shared/hooks/useProviderSummary";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { MEDIA_PROVIDER_KINDS, AI_PROVIDERS, getProvidersByKind } from "@/shared/constants/providers";

// webSearch/webFetch list pages do not exist: they 404 via notFound()
// below (G17). The combined page is /dashboard/media-providers/web.

// 9Router Pro: per-connection status math moved server-side (?summary=1).

function MediaProviderCard({ provider, kind, stats, isCustom, onToggle }) {
  const providerInfo = AI_PROVIDERS[provider.id];
  const isNoAuth = !!providerInfo?.noAuth;

  // 9Router Pro: counts come from the server-side summary (?summary=1).
  const { connected = 0, error = 0, total = 0, allDisabled = false } = stats || {};

  const handleToggleClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (onToggle) onToggle(provider.id, allDisabled);
  };

  const renderStatus = () => {
    if (isNoAuth) return <Badge variant="success" size="sm">Ready</Badge>;
    if (allDisabled) return <Badge variant="default" size="sm">Disabled</Badge>;
    if (total === 0) return <span className="text-xs text-text-muted">No connections</span>;
    return (
      <>
        {connected > 0 && <Badge variant="success" size="sm" dot>{connected} Connected</Badge>}
        {error > 0 && <Badge variant="error" size="sm" dot>{error} Error</Badge>}
        {connected === 0 && error === 0 && <Badge variant="default" size="sm">{total} Added</Badge>}
      </>
    );
  };

  return (
    <Link href={`/dashboard/media-providers/${kind}/${provider.id}`} className="group">
      <Card
        padding="xs"
        className={`h-full hover:bg-black/[0.01] dark:hover:bg-white/[0.01] transition-colors cursor-pointer ${allDisabled ? "opacity-50" : ""}`}
      >
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div
              className="size-8 rounded-lg flex items-center justify-center shrink-0"
              style={{ backgroundColor: `${provider.color?.length > 7 ? provider.color : (provider.color ?? "#888") + "15"}` }}
            >
              <ProviderIcon
                src={`/providers/${provider.id}.png`}
                alt={provider.name}
                size={30}
                className="object-contain rounded-lg max-w-[30px] max-h-[30px]"
                fallbackText={provider.textIcon || provider.id.slice(0, 2).toUpperCase()}
                fallbackColor={provider.color}
              />
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-sm">{provider.name}</h3>
              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                {isCustom && <Badge variant="default" size="sm">Custom</Badge>}
                {renderStatus()}
              </div>
            </div>
          </div>
          {total > 0 && (
            <div
              className="shrink-0 transition-opacity"
              onClick={handleToggleClick}
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
      </Card>
    </Link>
  );
}

export default function MediaProviderKindPage() {
  const notify = useNotificationStore();
  const { kind } = useParams();
  const { statsMap, setStatsMap } = useProviderSummary();
  const [customNodes, setCustomNodes] = useState([]);
  const [showAddCustomEmbedding, setShowAddCustomEmbedding] = useState(false);

  // webSearch/webFetch listing pages are gone (G17): kindConfig is
  // undefined for them, so the notFound() below serves a 404.
  const kindConfig = MEDIA_PROVIDER_KINDS.find((k) => k.id === kind);
  const isEmbedding = kind === "embedding";

  useEffect(() => {
    if (!kindConfig) return;
    if (isEmbedding) {
      fetch("/api/provider-nodes", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => setCustomNodes((d.nodes || []).filter((n) => n.type === "custom-embedding")))
        .catch(() => {});
    }
  }, [isEmbedding, kindConfig]);

  if (!kindConfig) return notFound();

  const providers = getProvidersByKind(kind);

  // Map custom nodes to MediaProviderCard shape
  const customProviders = customNodes.map((n) => ({
    id: n.id,
    name: n.name || "Custom Embedding",
    color: "#6366F1",
    textIcon: "CE",
  }));

  const allProviders = [...providers, ...customProviders];

  // 9Router Pro: merge per-authType summary entries into one per provider.
  const statsFor = (providerId) => {
    const entries = Object.values(statsMap).filter((s) => s.provider === providerId);
    const merged = { total: 0, connected: 0, error: 0, allDisabled: false };
    for (const s of entries) {
      merged.total += s.total;
      merged.connected += s.connected;
      merged.error += s.error;
    }
    merged.allDisabled = entries.length > 0 && entries.every((s) => s.allDisabled);
    return merged;
  };

  // 9Router Pro: one bulk PATCH instead of one PUT per connection.
  const handleToggleProvider = async (providerId, newActive) => {
    const authTypes = [...new Set(
      Object.values(statsMap).filter((s) => s.provider === providerId).map((s) => s.authType)
    )];
    setStatsMap((prev) => {
      const next = { ...prev };
      for (const [k, v] of Object.entries(next)) {
        if (v.provider === providerId) next[k] = { ...v, allDisabled: !newActive };
      }
      return next;
    });
    if (authTypes.length === 0) return;
    await fetch("/api/providers", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: providerId, authTypes, isActive: newActive }),
    }).catch(() => {});
  };

  return (
    <div className="flex flex-col gap-6">
      {isEmbedding && (
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" icon="add" onClick={() => setShowAddCustomEmbedding(true)}>
            Add Custom Embedding
          </Button>
        </div>
      )}

      {allProviders.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-border rounded-xl text-text-muted text-sm">
          No providers support <strong>{kindConfig.label}</strong> yet.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {providers.map((provider) => (
            <MediaProviderCard
              key={provider.id}
              provider={provider}
              kind={kind}
              stats={statsFor(provider.id)}
              onToggle={handleToggleProvider}
            />
          ))}
          {customProviders.map((provider) => (
            <MediaProviderCard
              key={provider.id}
              provider={provider}
              kind={kind}
              stats={statsFor(provider.id)}
              isCustom
              onToggle={handleToggleProvider}
            />
          ))}
        </div>
      )}

      {isEmbedding && (
        <AddCustomEmbeddingModal
          isOpen={showAddCustomEmbedding}
          onClose={() => setShowAddCustomEmbedding(false)}
          onCreated={(node) => {
            setCustomNodes((prev) => [...prev, node]);
            setShowAddCustomEmbedding(false);
          }}
        />
      )}
    </div>
  );
}
