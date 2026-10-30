import { describe, it, expect } from "vitest";
import {
  parseAutoTarget,
  buildAutoCandidates,
  AUTO_CANDIDATE_LIMIT,
} from "@/sse/services/autoRouting.js";

const clean = (provider, extra = {}) => ({
  id: `${provider}-1`,
  provider,
  isActive: true,
  ...extra,
});
const suspect = (provider) =>
  clean(provider, { backoffLevel: 2, lastError: "boom", lastErrorAt: new Date().toISOString() });

describe("parseAutoTarget", () => {
  it("parses known intents case-insensitively", () => {
    expect(parseAutoTarget("auto:coding")).toBe("coding");
    expect(parseAutoTarget("AUTO:FAST")).toBe("fast");
    expect(parseAutoTarget("auto:headroom")).toBe("headroom");
    expect(parseAutoTarget("auto:cheap")).toBe("cheap");
  });
  it("rejects unknown intents and non-auto strings", () => {
    expect(parseAutoTarget("auto:bogus")).toBeNull();
    expect(parseAutoTarget("dahl/deepseek-ai/DeepSeek-V4-Flash-0731")).toBeNull();
    expect(parseAutoTarget("coding")).toBeNull();
    expect(parseAutoTarget(null)).toBeNull();
  });
});

describe("buildAutoCandidates", () => {
  it("offers registry seeds of providers with active connections", () => {
    const out = buildAutoCandidates({ intent: "coding", connections: [clean("dahl")] });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((m) => m.startsWith("dahl/"))).toBe(true);
  });
  it("skips inactive connections entirely", () => {
    const out = buildAutoCandidates({
      intent: "coding",
      connections: [{ ...clean("dahl"), isActive: false }],
    });
    expect(out).toEqual([]);
  });
  it("ranks a clean provider above a suspect-only provider", () => {
    const out = buildAutoCandidates({
      intent: "coding",
      connections: [suspect("dahl"), clean("openai")],
    });
    expect(out[0].startsWith("openai/")).toBe(true);
    expect(out.some((m) => m.startsWith("dahl/"))).toBe(true);
  });
  it("honours enabledModels restrictions (full and bare forms)", () => {
    const out = buildAutoCandidates({
      intent: "coding",
      connections: [
        clean("dahl", {
          providerSpecificData: { enabledModels: ["dahl/deepseek-ai/DeepSeek-V4-Flash-0731"] },
        }),
      ],
    });
    expect(out).toEqual(["dahl/deepseek-ai/DeepSeek-V4-Flash-0731"]);
  });
  it("excludes dashboard-disabled models", () => {
    const out = buildAutoCandidates({
      intent: "coding",
      connections: [clean("dahl")],
      disabled: { dahl: ["zai-org/GLM-5.3-Flash"] },
    });
    expect(out.some((m) => m.includes("GLM-5.3-Flash"))).toBe(false);
    expect(out.length).toBeGreaterThan(0);
  });
  it("prefers free providers for cheap", () => {
    const out = buildAutoCandidates({
      intent: "cheap",
      connections: [clean("dahl"), clean("opencode")],
    });
    // opencode seeds carry :free-free ids (free tier); dahl is paid.
    expect(out[0].startsWith("opencode/")).toBe(true);
  });
  it("caps the candidate list", () => {
    const providers = ["dahl", "openai", "anthropic", "gemini-cli", "opencode", "kiro"];
    const out = buildAutoCandidates({ intent: "coding", connections: providers.map((p) => clean(p)) });
    expect(out.length).toBeLessThanOrEqual(AUTO_CANDIDATE_LIMIT);
  });
  it("returns [] for unknown intent", () => {
    expect(buildAutoCandidates({ intent: "bogus", connections: [clean("dahl")] })).toEqual([]);
  });
});
