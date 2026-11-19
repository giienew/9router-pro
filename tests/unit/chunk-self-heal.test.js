// Stale-chunk self-heal: a chunk URL from the previous build 404s after a
// deploy, and the page would otherwise stay broken. The detector must
// recognize the chunk-load failure shapes, and the reload guard must stop
// an immediate reload loop while still allowing a later deploy to heal.
import { describe, it, expect } from "vitest";

import {
  isChunkLoadError,
  shouldHealChunkError,
  CHUNK_RELOAD_FLAG_KEY,
  CHUNK_RELOAD_GUARD_MS,
} from "../../src/shared/utils/chunkErrors.js";

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

describe("isChunkLoadError", () => {
  it("recognizes the chunk-load failure shapes", () => {
    expect(isChunkLoadError(new Error("Loading chunk 123 failed"))).toBe(true);
    expect(isChunkLoadError(new Error("ChunkLoadError: Loading chunk 42 failed"))).toBe(true);
    expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(true);
    expect(isChunkLoadError(new Error("Importing a module script failed."))).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isChunkLoadError(new Error("NetworkError when attempting to fetch resource."))).toBe(false);
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError("")).toBe(false);
  });
});

describe("shouldHealChunkError", () => {
  it("allows the first reload and records the timestamp", () => {
    const storage = memoryStorage();
    expect(shouldHealChunkError(storage)).toBe(true);
    expect(Number(storage.getItem(CHUNK_RELOAD_FLAG_KEY))).toBeGreaterThan(0);
  });

  it("blocks an immediate second reload (loop guard)", () => {
    const storage = memoryStorage();
    expect(shouldHealChunkError(storage)).toBe(true);
    expect(shouldHealChunkError(storage)).toBe(false);
  });

  it("allows a reload again after the guard window passes", () => {
    const storage = memoryStorage();
    expect(shouldHealChunkError(storage)).toBe(true);
    storage.setItem(CHUNK_RELOAD_FLAG_KEY, String(Date.now() - CHUNK_RELOAD_GUARD_MS - 1000));
    expect(shouldHealChunkError(storage)).toBe(true);
  });

  it("reloads when storage is unavailable", () => {
    expect(shouldHealChunkError(null)).toBe(true);
  });
});
