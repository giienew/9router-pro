"use client";

import { useState, useEffect, useCallback } from "react";

/**
 * Incremental "Load more" windowing for long card/chip lists (P2-20).
 * Renders only the first `step` items, then appends `step` more per click,
 * instead of mounting hundreds of cards at once. Resets to the first page
 * whenever `resetKey` changes (search query / status filter / kind filter).
 *
 * @param {number} total - full list length
 * @param {string} resetKey - changes reset the window (e.g. search + filter)
 * @param {number} step - items per page (default 24, one grid row-set)
 * @returns {{ visible: number, hasMore: boolean, remaining: number, showMore: () => void }}
 */
export function useVisibleCount(total, resetKey, step = 24) {
  const [count, setCount] = useState(step);
  useEffect(() => {
    setCount(step);
  }, [resetKey, step]);
  const visible = Math.min(count, total);
  const showMore = useCallback(() => setCount((c) => c + step), [step]);
  return { visible, hasMore: count < total, remaining: Math.max(0, total - visible), showMore };
}
