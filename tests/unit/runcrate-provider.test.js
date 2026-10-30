import { describe, it, expect } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { MODEL_PRICING } from "../../open-sse/providers/pricing.js";

describe("Runcrate provider (upstream 0.5.111)", () => {
  it("registers runcrate with the rc alias and six catalog models", () => {
    const entry = REGISTRY.find((r) => r.id === "runcrate");
    expect(entry).toBeDefined();
    expect(entry.aliases).toContain("rc");
    expect(entry.uiAlias).toBe("rc");
    const models = PROVIDER_MODELS.runcrate || PROVIDER_MODELS.rc;
    expect(models.map((m) => m.id)).toEqual([
      "deepseek-ai/DeepSeek-V4.1-Flash",
      "deepseek-ai/DeepSeek-V4.1-Flash-1017",
      "zai-org/GLM-5.3",
      "zai-org/GLM-5.3-Flash",
      "Qwen/Qwen3.8-Flash",
      "openai/gpt-oss-120b",
    ]);
  });

  it("validates via the billing-balance endpoint, not the public models endpoint", () => {
    // /v1/models answers 200 for any key, so it cannot tell a bad key from a
    // good one; the billing API can (upstream b9c27225).
    expect(PROVIDERS.runcrate.validateUrl).toBe("https://www.runcrate.ai/api/v1/billing/balance");
    expect(PROVIDERS.runcrate.baseUrl).toBe("https://api.runcrate.ai/v1/chat/completions");
  });

  it("claims no pricing rows beyond the upstream diff", () => {
    // Upstream's runcrate diff contains no pricing.js rows; do not invent any.
    expect(MODEL_PRICING["deepseek-ai/DeepSeek-V4.1-Flash"]).toBeUndefined();
  });
});
