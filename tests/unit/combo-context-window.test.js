// Combo context-window mode (rival-ref sweep 2026-11-19, Go's combo
// context-window mode min/max/custom): cleanComboContextWindow normalizes
// a (mode, value) pair for storage, resolveComboContextWindow picks the
// advertised window from the members' min/max and the stored mode.
import { describe, it, expect } from "vitest";
import {
  COMBO_CONTEXT_WINDOW_MODES,
  cleanComboContextWindow,
  resolveComboContextWindow,
} from "../../src/lib/db/repos/combosRepo.js";

describe("cleanComboContextWindow", () => {
  it("defaults an unknown mode to min with no custom value", () => {
    expect(cleanComboContextWindow(undefined, undefined)).toEqual({ contextWindowMode: "min", contextWindow: null });
    expect(cleanComboContextWindow("bogus", 1000)).toEqual({ contextWindowMode: "min", contextWindow: null });
  });

  it("keeps min and max, dropping any custom value", () => {
    expect(cleanComboContextWindow("min", 500000)).toEqual({ contextWindowMode: "min", contextWindow: null });
    expect(cleanComboContextWindow("max", 500000)).toEqual({ contextWindowMode: "max", contextWindow: null });
  });

  it("keeps a custom mode with a positive integer value (floored)", () => {
    expect(cleanComboContextWindow("custom", 200000)).toEqual({ contextWindowMode: "custom", contextWindow: 200000 });
    expect(cleanComboContextWindow("custom", "128000")).toEqual({ contextWindowMode: "custom", contextWindow: 128000 });
    expect(cleanComboContextWindow("custom", 100000.9)).toEqual({ contextWindowMode: "custom", contextWindow: 100000 });
  });

  it("falls back to min when custom has no usable value", () => {
    expect(cleanComboContextWindow("custom", 0)).toEqual({ contextWindowMode: "min", contextWindow: null });
    expect(cleanComboContextWindow("custom", -5)).toEqual({ contextWindowMode: "min", contextWindow: null });
    expect(cleanComboContextWindow("custom", NaN)).toEqual({ contextWindowMode: "min", contextWindow: null });
    expect(cleanComboContextWindow("custom", "abc")).toEqual({ contextWindowMode: "min", contextWindow: null });
    expect(cleanComboContextWindow("custom", null)).toEqual({ contextWindowMode: "min", contextWindow: null });
  });

  it("exposes exactly the three supported modes", () => {
    expect([...COMBO_CONTEXT_WINDOW_MODES].sort()).toEqual(["custom", "max", "min"]);
  });
});

describe("resolveComboContextWindow", () => {
  it("min (default) advertises the smallest member window", () => {
    expect(resolveComboContextWindow("min", null, 128000, 1000000)).toBe(128000);
    expect(resolveComboContextWindow(undefined, null, 128000, 1000000)).toBe(128000);
    expect(resolveComboContextWindow(null, null, 128000, 1000000)).toBe(128000);
  });

  it("max advertises the largest member window", () => {
    expect(resolveComboContextWindow("max", null, 128000, 1000000)).toBe(1000000);
  });

  it("custom advertises the stored value, ignoring the members", () => {
    expect(resolveComboContextWindow("custom", 200000, 128000, 1000000)).toBe(200000);
  });

  it("custom falls back to min when the stored value is unusable", () => {
    expect(resolveComboContextWindow("custom", null, 128000, 1000000)).toBe(128000);
    expect(resolveComboContextWindow("custom", 0, 128000, 1000000)).toBe(128000);
  });

  it("max falls back to min when no member window is known", () => {
    expect(resolveComboContextWindow("max", null, 128000, -Infinity)).toBe(128000);
  });

  it("returns undefined when no member window is known at all", () => {
    expect(resolveComboContextWindow("min", null, Infinity, -Infinity)).toBeUndefined();
    expect(resolveComboContextWindow("max", null, Infinity, -Infinity)).toBeUndefined();
  });
});
