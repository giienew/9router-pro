"use client";

import { useEffect } from "react";
import { isChunkLoadError, shouldHealChunkError } from "@/shared/utils/chunkErrors";

// Self-heal stale chunks after a deploy: a chunk URL from the previous
// build 404s, and the page would otherwise stay broken. On a chunk-load
// failure, reload once to fetch the fresh build (guarded against loops).
export function ChunkSelfHeal() {
  useEffect(() => {
    const onError = (event) => {
      if (isChunkLoadError(event?.error || event?.message) && shouldHealChunkError()) {
        window.location.reload();
      }
    };
    const onRejection = (event) => {
      if (isChunkLoadError(event?.reason) && shouldHealChunkError()) {
        window.location.reload();
      }
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
