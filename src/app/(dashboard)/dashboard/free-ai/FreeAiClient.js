"use client";

// 9Router Pro — Free AI: one-click wiring for genuinely free
// OpenAI-compatible services (see constants/freeAi.js). Keyless services
// store a placeholder key; free-key services take the user's own key.

import { useCallback, useEffect, useState } from "react";
import { FREE_AI_SERVICES } from "@/shared/constants/freeAi";

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { res, data };
}

function ServiceCard({ service, connectedCount, onAdded }) {
  const [keyInput, setKeyInput] = useState("");
  const [state, setState] = useState("idle"); // idle | adding | error
  const [error, setError] = useState("");
  const needsKey = service.keyMode === "free-key";
  const canAdd = !needsKey || keyInput.trim().length > 0;

  const add = async () => {
    setState("adding");
    setError("");
    try {
      let providerRef = service.provider;
      if (service.kind === "node") {
        const { res, data } = await api("/api/provider-nodes", {
          method: "POST",
          body: { name: service.prefix, prefix: service.prefix, apiType: "chat", baseUrl: service.baseUrl, type: "openai-compatible" },
        });
        if (!res.ok && res.status !== 409) throw new Error(data?.error || `Node create failed (${res.status})`);
        providerRef = data?.node?.id || data?.id;
        if (!providerRef) {
          // Node already exists — find it by prefix.
          const list = await api("/api/provider-nodes");
          const found = (list.data?.nodes || []).find((n) => n.prefix === service.prefix);
          if (!found) throw new Error("Could not create or find the provider node");
          providerRef = found.id;
        }
      }
      const apiKey = needsKey || keyInput.trim() ? keyInput.trim() : service.placeholderKey;
      const connName = connectedCount > 0 ? `${service.name} ${connectedCount + 1}` : service.name;
      const { res, data } = await api("/api/providers", {
        method: "POST",
        body: { provider: providerRef, apiKey, name: connName },
      });
      if (!res.ok) throw new Error(data?.error || `Connection failed (${res.status})`);
      setKeyInput("");
      setState("idle");
      onAdded();
    } catch (e) {
      setState("error");
      setError(e.message || "Failed to add");
    }
  };

  return (
    <div className="flex flex-col rounded-[14px] border border-border-subtle bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-medium text-text-main">{service.name}</h3>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${service.keyMode === "none" ? "bg-emerald-500/15 text-emerald-500" : "bg-brand-500/15 text-brand-500"}`}>
          {service.badge}
        </span>
      </div>
      <p className="mt-1.5 text-sm text-text-muted">{service.blurb}</p>
      <p className="mt-2 text-xs text-text-muted/80">
        <span className="material-symbols-outlined align-[-2px] text-[14px]">speed</span> {service.limits}
      </p>
      <p className="mt-1 font-mono text-[11px] text-text-muted/70">{service.modelsHint}</p>

      <div className="mt-auto pt-4">
        {connectedCount > 0 && (
          <p className="mb-2 flex items-center gap-1 text-xs font-medium text-emerald-500">
            <span className="material-symbols-outlined text-[14px]">check_circle</span>
            Connected ({connectedCount}) — manage it on the Providers page
          </p>
        )}
        {needsKey || service.keyMode === "optional" ? (
          <input
            type="text"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder={needsKey ? "Paste your free API key" : "Free token (optional — blank works too)"}
            className="mb-2 w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-text-main outline-none focus:border-brand-500"
          />
        ) : null}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={add}
            disabled={state === "adding" || !canAdd}
            className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {state === "adding" ? "Adding…" : connectedCount > 0 ? "Add another" : "Add provider"}
          </button>
          {service.keyUrl && (
            <a href={service.keyUrl} target="_blank" rel="noreferrer" className="text-xs text-text-muted underline hover:text-brand-500">
              Get a free key
            </a>
          )}
          <a href={service.homeUrl} target="_blank" rel="noreferrer" className="ml-auto text-xs text-text-muted/70 underline hover:text-brand-500">
            Website
          </a>
        </div>
        {state === "error" && <p className="mt-2 text-xs text-red-500">{error}</p>}
      </div>
    </div>
  );
}

export default function FreeAiClient() {
  const [connections, setConnections] = useState([]);
  const [nodes, setNodes] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [prov, nodeRes] = await Promise.all([api("/api/providers"), api("/api/provider-nodes")]);
      setConnections(prov.data?.connections || prov.data?.providers || []);
      setNodes(nodeRes.data?.nodes || []);
    } catch { /* keep last state */ }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const countFor = (service) => {
    if (service.kind === "node") {
      const node = nodes.find((n) => n.prefix === service.prefix);
      if (!node) return 0;
      return connections.filter((c) => c.provider === node.id).length;
    }
    return connections.filter((c) => c.provider === service.provider).length;
  };

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-text-main">
            <span className="material-symbols-outlined text-brand-500">redeem</span>
            Free AI
          </h1>
          <p className="mt-0.5 text-sm text-text-muted">
            Free OpenAI-compatible services, wired into your router in one click. A 9Router Pro extra — keyless where possible, your own free key where not.
          </p>
          <p className="mt-0.5 text-xs text-text-muted/70">
            9Router Pro · by Gienetic ·{" "}
            <a href="https://github.com/giienew" target="_blank" rel="noreferrer" className="underline hover:text-brand-500">GitHub</a>{" "}
            ·{" "}
            <a href="https://t.me/gienetic" target="_blank" rel="noreferrer" className="underline hover:text-brand-500">Telegram</a>
          </p>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {FREE_AI_SERVICES.map((service) => (
            <ServiceCard key={service.id} service={service} connectedCount={countFor(service)} onAdded={refresh} />
          ))}
        </div>
      )}

      <div className="mt-5 rounded-[14px] border border-border-subtle bg-surface p-4 text-sm text-text-muted">
        <p className="flex items-center gap-1.5 font-medium text-text-main">
          <span className="material-symbols-outlined text-[16px] text-brand-500">info</span>
          How it works
        </p>
        <p className="mt-1.5">
          Adding a service creates a normal provider connection — models are auto-discovered and show up in the model
          picker right away (for Pollinations, under the <span className="font-mono text-xs">pollinations/</span> prefix).
          Free tiers are rate-limited by the services themselves; combine several into a combo for a resilient free stack.
        </p>
      </div>
    </div>
  );
}
