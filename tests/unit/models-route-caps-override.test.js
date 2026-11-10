// /api/models publishes editor overrides — including onto listed models.
//
// A custom row whose providerAlias/id collides with a listed routedModel is
// a shadow: legacy rows (no capsOverride) are dropped (see
// models-route-shadow-dedupe.test.js). A row carrying an editor override is
// NOT dropped — its sparse override merges onto the listed entry, so an
// edited model's contextWindow/maxOutput reach clients that read /api/models
// (dashboard, VS Code Copilot via /v1/models). Survivor rows merge the
// override over the legacy caps.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/models", () => ({
  getModelAliases: vi.fn(async () => ({})),
  setModelAlias: vi.fn(),
  getCustomModels: vi.fn(async () => []),
}));
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => ({})),
}));

import { GET, __resetModelsCache } from "@/app/api/models/route.js";
import { getCustomModels } from "@/models";

async function fetchModels() {
  const res = await GET();
  const body = await res.json();
  return body.models || [];
}

beforeEach(() => {
  vi.mocked(getCustomModels).mockClear();
  __resetModelsCache();
});

describe("/api/models — editor override publishing", () => {
  it("merges a shadow row's capsOverride onto the listed entry instead of dropping it", async () => {
    vi.mocked(getCustomModels).mockResolvedValueOnce([
      { providerAlias: "ocg", id: "claude-haiku-5-5", type: "llm", name: "claude-haiku-5-5", caps: { vision: true, reasoning: true }, capsOverride: { contextWindow: 500000, vision: false } },
    ]);

    const models = await fetchModels();
    const routed = models.filter((m) => m.routedModel === "ocg/claude-haiku-5-5" || m.fullModel === "opencode-go/claude-haiku-5-5");

    expect(routed).toHaveLength(1);
    expect(routed[0].fullModel).toBe("opencode-go/claude-haiku-5-5");
    // Override wins for the fields it sets…
    expect(routed[0].caps.contextWindow).toBe(500000);
    expect(routed[0].caps.vision).toBe(false);
    // …and detection survives for the fields it does not set.
    expect(routed[0].caps.maxOutput).toBe(128000);
    expect(routed[0].caps.reasoning).toBe(true);
  });

  it("publishes a survivor row's capsOverride numbers over its legacy caps", async () => {
    vi.mocked(getCustomModels).mockResolvedValueOnce([
      { providerAlias: "cmc", id: "some-totally-custom-model", type: "llm", name: "x", caps: { vision: false, reasoning: false }, capsOverride: { vision: true, contextWindow: 999000, maxOutput: 777 } },
    ]);

    const models = await fetchModels();
    const kept = models.find((m) => m.fullModel === "cmc/some-totally-custom-model");
    expect(kept).toBeDefined();
    expect(kept.caps.vision).toBe(true);
    expect(kept.caps.contextWindow).toBe(999000);
    expect(kept.caps.maxOutput).toBe(777);
  });

  it("ignores junk inside capsOverride and keeps the detected values", async () => {
    vi.mocked(getCustomModels).mockResolvedValueOnce([
      { providerAlias: "cmc", id: "some-totally-custom-model", type: "llm", name: "x", capsOverride: { vision: "yes", contextWindow: -5, maxOutput: "not a number", bogusKey: true } },
    ]);

    const models = await fetchModels();
    const kept = models.find((m) => m.fullModel === "cmc/some-totally-custom-model");
    expect(kept).toBeDefined();
    // cmc = commandcode branch: 1M/384k for unlisted models.
    expect(kept.caps.contextWindow).toBe(1000000);
    expect(kept.caps.maxOutput).toBe(384000);
    expect(kept.caps.bogusKey).toBeUndefined();
  });
});
