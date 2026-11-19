import { describe, it, expect } from "vitest";
import { getPricingForModel, MODEL_PRICING, PATTERN_PRICING } from "../../open-sse/providers/pricing.js";

describe("gemini-4-hydrogen-sonar pricing (audit F-5)", () => {
  it("is priced via the gemini-4-* pattern (2.00/10.00)", () => {
    expect(getPricingForModel("antigravity", "gemini-4-hydrogen-sonar")).toEqual({
      input: 2.00,
      output: 10.00,
      cached: 0.10,
      reasoning: 10.00,
      cache_creation: 2.00,
    });
  });

  it("cache_creation follows the Gemini $2-input precedent (1x input, not 0.1875)", () => {
    // Every other $2.00-input Gemini row charges cache_creation at 1x input
    // (gemini-3-pro-preview, gemini-2.5-pro, gemini-3.1-pro-low). The pattern
    // shipped with 0.1875 — 0.09x input, a decimal slip from the 3.8 row's
    // 1.875 — which undercharged cache-creation tokens 10x.
    expect(MODEL_PRICING["gemini-3-pro-preview"].cache_creation).toBe(2.00);
    expect(MODEL_PRICING["gemini-2.5-pro"].cache_creation).toBe(2.00);
    const pattern = PATTERN_PRICING.find((p) => p.pattern === "gemini-4-*");
    expect(pattern).toBeDefined();
    expect(pattern.pricing.cache_creation).toBe(2.00);
  });
});
