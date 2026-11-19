import { describe, expect, it, vi } from "vitest";
import { setCatalogSource } from "../../open-sse/providers/capabilities.js";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
  getInjectVariants: vi.fn(async () => ({})),
}));

vi.mock("@/lib/localDb", async (importOriginal) => {
  // Spread the real module so pure helpers the route imports (e.g.
  // resolveComboContextWindow for the combo context-window mode) keep
  // their real implementation; only the DB-backed readers are mocked.
  const actual = await importOriginal();
  return {
    ...actual,
    getProviderConnections: db.getProviderConnections,
    getCombos: db.getCombos,
    getCustomModels: db.getCustomModels,
    getModelAliases: db.getModelAliases,
    getInjectVariants: db.getInjectVariants,
  };
});
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => ({})),
}));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

const syncedLimits = { contextWindow: 180000, maxOutput: 16000 };

async function modelsWithCombo(providerId, modelId, combos) {
  db.getProviderConnections.mockResolvedValue([{
    id: 1,
    provider: providerId,
    isActive: true,
    providerSpecificData: { enabledModels: [modelId] },
  }]);
  db.getCombos.mockResolvedValue(combos);
  setCatalogSource({
    getModalities: () => null,
    getLimits: (provider, model) =>
      provider === providerId && model === modelId ? syncedLimits : null,
  });
  try {
    return await buildModelsList(["llm"]);
  } finally {
    setCatalogSource(null);
  }
}

describe("/v1/models combo limits", () => {
  it.each([
    ["ocg", "opencode-go", "mimo-v2.5"],
    ["xmtp", "xiaomi-tokenplan", "mimo-v2.5"],
    ["ps", "poolside", "custom-model"],
    ["ds", "deepseek", "deepseek-chat"],
  ])("uses the real provider for a %s UI-alias seat", async (uiAlias, providerId, modelId) => {
    const combo = { name: "ui-alias-combo", models: [`${uiAlias}/${modelId}`] };
    const models = await modelsWithCombo(providerId, modelId, [combo]);
    const published = models.find((model) => model.id === combo.name);

    expect(published).toMatchObject({
      context_length: 180000,
      max_completion_tokens: 16000,
      capabilities: { contextWindow: 180000, maxOutput: 16000 },
    });
  });

  it("carries provider-scoped limits through a nested combo", async () => {
    const models = await modelsWithCombo("opencode-go", "mimo-v2.5", [
      { name: "inner-combo", models: ["ocg/mimo-v2.5"] },
      { name: "outer-combo", models: ["inner-combo"] },
    ]);
    const outer = models.find((model) => model.id === "outer-combo");

    expect(outer).toMatchObject({
      context_length: 180000,
      max_completion_tokens: 16000,
      capabilities: { contextWindow: 180000, maxOutput: 16000 },
    });
  });

  it("publishes Devin CLI's 200k limit for a dv combo seat", async () => {
    const models = await modelsWithCombo("devin-cli", "gpt-5.5-high", [
      { name: "devin-combo", models: ["dv/gpt-5.5-high"] },
    ]);
    const combo = models.find((model) => model.id === "devin-combo");

    expect(combo).toMatchObject({
      context_length: 200000,
      capabilities: { contextWindow: 200000 },
    });
  });

  it("lists a variant name as a model without a backing combo", async () => {
    db.getInjectVariants.mockResolvedValue({
      "my-variant": { model: "dahl/deepseek-ai/DeepSeek-V4-Flash-0731", enabled: true },
    });
    const models = await modelsWithCombo("dahl", "deepseek-ai/DeepSeek-V4-Flash-0731", []);
    expect(models.find((model) => model.id === "my-variant")).toMatchObject({
      object: "model",
      owned_by: "variant",
    });
  });

  it("skips a variant whose name still has a backing combo", async () => {
    db.getInjectVariants.mockResolvedValue({
      "dup-name": { model: "dahl/deepseek-ai/DeepSeek-V4-Flash-0731", enabled: true },
    });
    const models = await modelsWithCombo("dahl", "deepseek-ai/DeepSeek-V4-Flash-0731", [
      { name: "dup-name", models: ["dahl/deepseek-ai/DeepSeek-V4-Flash-0731"] },
    ]);
    const dupes = models.filter((model) => model.id === "dup-name");
    expect(dupes).toHaveLength(1);
    expect(dupes[0].owned_by).toBe("combo");
  });

  it("never publishes a combo prompt in /v1/models (issue #2)", async () => {
    // Combo entries are built field-by-field, so the prompt must never
    // leak into the public model list — not even as a key.
    const combo = {
      name: "prompted-combo",
      models: ["ocg/mimo-v2.5"],
      prompt: { mode: "single", content: "SECRET-PROMPT", turns: [], position: "append", enabled: true },
    };
    const models = await modelsWithCombo("opencode-go", "mimo-v2.5", [combo]);
    const published = models.find((model) => model.id === combo.name);
    expect(published).toBeDefined();
    expect(published).not.toHaveProperty("prompt");
    expect(JSON.stringify(published)).not.toContain("SECRET-PROMPT");
  });
});
