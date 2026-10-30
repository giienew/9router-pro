"use client";

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Modal, Button, Input } from "@/shared/components";

// R10 cross-provider live catalog search modal. Searches the aggregated
// catalog (live per-provider feeds + registry seeds where no feed exists)
// by name, context length, price, vision and reasoning. Import writes to
// Pro's own model registry via POST /api/models/custom — the same endpoint
// the per-provider Add Custom Model flow uses.
export default function CatalogSearchModal({ isOpen, onClose }) {
  const [q, setQ] = useState("");
  const [minContext, setMinContext] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [vision, setVision] = useState(false);
  const [reasoning, setReasoning] = useState(false);
  const [results, setResults] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [added, setAdded] = useState(new Set());

  const search = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, limit: "50" });
      if (minContext) params.set("minContext", minContext);
      if (maxPrice) params.set("maxPrice", maxPrice);
      if (vision) params.set("vision", "1");
      if (reasoning) params.set("reasoning", "1");
      const res = await fetch(`/api/providers/catalog-search?${params}`);
      const data = await res.json();
      setResults(data.models || []);
      setTotal(data.total || 0);
    } catch { setResults([]); }
    setLoading(false);
  }, [q, minContext, maxPrice, vision, reasoning]);

  useEffect(() => { if (isOpen) search(); }, [isOpen, search]);

  const importModel = async (m) => {
    try {
      const res = await fetch("/api/models/custom", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerAlias: m.provider, id: m.id, type: "llm" }),
      });
      if (res.ok) {
        setAdded((prev) => new Set(prev).add(m.fullId));
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("customModelChanged"));
      }
    } catch {}
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Search all model catalogs" size="lg">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, id or provider…" className="min-w-[200px] flex-1" />
          <Button size="sm" onClick={search} disabled={loading}>{loading ? "Searching…" : "Search"}</Button>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-1.5">Min context
            <select value={minContext} onChange={(e) => setMinContext(e.target.value)} className="rounded-lg border border-border bg-surface px-2 py-1.5">
              <option value="">Any</option>
              <option value="32000">32k+</option>
              <option value="128000">128k+</option>
              <option value="200000">200k+</option>
              <option value="1000000">1M+</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5">Max price ($/1M)
            <input type="number" step="0.1" min="0" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} placeholder="Any" className="w-24 rounded-lg border border-border bg-surface px-2 py-1.5" />
          </label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} /> Vision</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={reasoning} onChange={(e) => setReasoning(e.target.checked)} /> Reasoning</label>
        </div>
        <p className="text-xs text-text-muted">{total} matching models (live feeds + registry seeds where a provider has no feed; price known only where the feed carries pricing).</p>
        <div className="flex max-h-[55vh] flex-col gap-1 overflow-y-auto">
          {results.map((m) => (
            <div key={m.fullId} className="flex items-center gap-2 rounded-lg border border-black/10 px-3 py-2 dark:border-white/10">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{m.name}</p>
                <p className="truncate font-mono text-xs text-text-muted">{m.fullId}{m.contextLength ? ` · ${(m.contextLength / 1000).toFixed(0)}k ctx` : ""}{m.vision ? " · vision" : ""}{m.reasoning ? " · reasoning" : ""}{m.price ? ` · $${m.price.prompt}/$${m.price.completion}` : ""} · {m.source}</p>
              </div>
              <Button size="sm" variant="outline" disabled={added.has(m.fullId)} onClick={() => importModel(m)}>
                {added.has(m.fullId) ? "Added" : "Import"}
              </Button>
            </div>
          ))}
          {!loading && results.length === 0 && <p className="py-4 text-center text-sm text-text-muted">No models match — try a broader search.</p>}
        </div>
      </div>
    </Modal>
  );
}

CatalogSearchModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
};
