"use client";

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import Card from "./Card";
import Select from "./Select";
import Badge from "./Badge";

const NONE_PROXY_POOL_VALUE = "__none__";
const STRATEGIES = [
  { value: "none", label: "None (single pool)" },
  { value: "round-robin", label: "Round-robin" },
  { value: "random", label: "Random" },
];

export default function NoAuthProxyCard({ providerId }) {
  const [proxyPools, setProxyPools] = useState([]);
  const [proxyPoolId, setProxyPoolId] = useState(NONE_PROXY_POOL_VALUE);
  const [rotateStrategy, setRotateStrategy] = useState("none");
  const [selectedPoolIds, setSelectedPoolIds] = useState([]);
  const [poolSearch, setPoolSearch] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/proxy-pools?isActive=true", { cache: "no-store" }).then((r) => r.ok ? r.json() : { proxyPools: [] }),
      fetch("/api/settings", { cache: "no-store" }).then((r) => r.ok ? r.json() : {}),
    ]).then(([poolData, settingsData]) => {
      if (cancelled) return;
      setProxyPools(poolData.proxyPools || []);
      const override = (settingsData.providerStrategies || {})[providerId] || {};
      setProxyPoolId(override.proxyPoolId || NONE_PROXY_POOL_VALUE);
      setRotateStrategy(override.rotateStrategy || "none");
      setSelectedPoolIds(Array.isArray(override.proxyPoolIds) ? override.proxyPoolIds : []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [providerId]);

  const save = useCallback(async (poolId, strategy, poolIds) => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      const current = data.providerStrategies || {};
      const override = { ...(current[providerId] || {}) };
      if (poolId === NONE_PROXY_POOL_VALUE) delete override.proxyPoolId;
      else override.proxyPoolId = poolId;
      if (strategy === "none") delete override.rotateStrategy;
      else override.rotateStrategy = strategy;
      if (Array.isArray(poolIds) && poolIds.length > 0) override.proxyPoolIds = poolIds;
      else delete override.proxyPoolIds;
      const updated = { ...current };
      if (Object.keys(override).length === 0) delete updated[providerId];
      else updated[providerId] = override;
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerStrategies: updated }),
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      console.log("Save proxy config error:", e);
    } finally {
      setSaving(false);
    }
  }, [providerId]);

  const handlePoolChange = (newPoolId) => {
    setProxyPoolId(newPoolId);
    save(newPoolId, rotateStrategy, selectedPoolIds);
  };

  const handleStrategyChange = (newStrategy) => {
    setRotateStrategy(newStrategy);
    if (newStrategy !== "none") setPickerOpen(true);
    save(proxyPoolId, newStrategy, selectedPoolIds);
  };

  const applySelection = (ids) => {
    setSelectedPoolIds(ids);
    save(proxyPoolId, rotateStrategy, ids);
  };

  const togglePool = (id) => {
    applySelection(selectedPoolIds.includes(id)
      ? selectedPoolIds.filter((x) => x !== id)
      : [...selectedPoolIds, id]);
  };

  const filteredPools = proxyPools.filter((pool) =>
    (pool.name || "").toLowerCase().includes(poolSearch.trim().toLowerCase()));

  const canRotate = proxyPools.length >= 2;
  const isRotation = rotateStrategy !== "none";

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-green-500/10 text-green-500">
          <span className="material-symbols-outlined text-[20px]">lock_open</span>
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium">No authentication required</p>
          <p className="text-xs text-text-muted">This provider is ready to use. To bypass IP-based limits, route requests through your own proxy pool — your own IP credentials only, no proxies are included.</p>
        </div>
        {savedFlash && <Badge variant="success" size="sm">Saved</Badge>}
      </div>

      <Select
        label="Proxy Pool"
        value={proxyPoolId}
        onChange={(e) => handlePoolChange(e.target.value)}
        disabled={saving || isRotation}
        options={[
          { value: NONE_PROXY_POOL_VALUE, label: "None (direct)" },
          ...proxyPools.map((pool) => ({ value: pool.id, label: pool.name })),
        ]}
        hint={isRotation ? (selectedPoolIds.length > 0 ? "Rotating through the selected pools." : "Pool selector is ignored when rotation is active — all active pools are used.") : undefined}
      />

      <div className="flex flex-col gap-2 mt-4">
        <label className="text-sm font-medium text-text-main">Rotation Strategy</label>
        <select
          value={rotateStrategy}
          onChange={(e) => handleStrategyChange(e.target.value)}
          disabled={saving}
          className="py-2 px-3 text-sm text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all disabled:opacity-50"
        >
          {STRATEGIES.map((s) => (
            <option key={s.value} value={s.value} disabled={s.value !== "none" && !canRotate}>
              {s.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-text-muted">
          {!canRotate
            ? "Need at least 2 active proxy pools for rotation."
            : isRotation && selectedPoolIds.length > 0
              ? <>{"Rotating through the "}{selectedPoolIds.length}{" selected pools."}</>
              : isRotation
                ? rotateStrategy === "round-robin"
                  ? <>{"Rotating through all "}{proxyPools.length}{" active pools in order. State is in-memory (resets on restart)."}</>
                  : <>{"Picking a random pool from "}{proxyPools.length}{" active pools each request."}</>
                : "Uses the selected pool above. Set to Round-robin or Random to rotate across all active pools."}
        </p>
      </div>

      {isRotation && (
        <div className="flex flex-col gap-2 mt-4">
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            aria-expanded={pickerOpen}
            className="flex items-center justify-between w-full text-left"
          >
            <span className="text-sm font-medium text-text-main">Rotation pools</span>
            <span className="flex items-center gap-1 text-xs text-text-muted">
              {selectedPoolIds.length > 0 ? <>{selectedPoolIds.length}{" pools selected"}</> : "All active pools"}
              <span className="material-symbols-outlined text-[18px]">{pickerOpen ? "expand_less" : "expand_more"}</span>
            </span>
          </button>
          {pickerOpen && (
            <>
              <input
                value={poolSearch}
                onChange={(e) => setPoolSearch(e.target.value)}
                placeholder="Search pools…"
                className="py-2 px-3 text-sm text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all"
              />
              <div className="flex gap-3">
                <button type="button" onClick={() => applySelection([...new Set([...selectedPoolIds, ...filteredPools.map((p) => p.id)])])} className="text-xs font-medium text-primary hover:underline">Select all shown</button>
                <button type="button" onClick={() => applySelection([])} className="text-xs font-medium text-text-muted hover:underline">Clear selection</button>
              </div>
              <div className="max-h-44 overflow-y-auto border border-black/10 dark:border-white/10 rounded-md divide-y divide-black/5 dark:divide-white/5">
                {filteredPools.slice(0, 100).map((pool) => (
                  <label key={pool.id} className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5">
                    <input type="checkbox" checked={selectedPoolIds.includes(pool.id)} onChange={() => togglePool(pool.id)} className="h-4 w-4 shrink-0 accent-primary" />
                    <span className="text-sm text-text-main truncate">{pool.name}</span>
                  </label>
                ))}
                {filteredPools.length === 0 && (
                  <p className="px-3 py-2 text-xs text-text-muted">No pools match your search</p>
                )}
              </div>
              {filteredPools.length > 100 && (
                <p className="text-xs text-text-muted">Showing first 100 matches — refine your search</p>
              )}
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setPickerOpen(false)}
                  className="px-4 py-1.5 text-sm font-medium text-white bg-primary rounded-md hover:opacity-90 transition"
                >
                  Done
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

NoAuthProxyCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};
