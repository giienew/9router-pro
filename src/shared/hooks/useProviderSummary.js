"use client";

import { useState, useEffect, useCallback } from "react";

/**
 * Single shared connection-summary fetch (B-F11). `/api/providers?summary=1`
 * returns pre-aggregated per-provider stats (`stats` keyed
 * `${providerId}|${authType}`), so pages never download every connection
 * just to count them. Pages that also mutate counts optimistically (toggle /
 * test) keep working: the raw `setStatsMap` setter is exposed alongside.
 * Also carries live provider-breaker states (P3-27), which bypass the
 * server's stats cache.
 *
 * @returns {{ statsMap: object, setStatsMap: function, breakers: object, loading: boolean, error: string|null, refresh: () => Promise<void> }}
 */
export function useProviderSummary() {
  const [statsMap, setStatsMap] = useState({});
  const [breakers, setBreakers] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/providers?summary=1", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        setStatsMap(data.stats || {});
        setBreakers(data.breakers || {});
        setError(null);
      } else {
        setError(data.error || `HTTP ${res.status}`);
      }
    } catch (e) {
      setError(e?.message || "Failed to load provider summary");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { statsMap, setStatsMap, breakers, loading, error, refresh };
}
