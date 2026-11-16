import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
  getInjectVariants: vi.fn(async () => ({})),
}));

vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => ({})),
}));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

function geminiConnection() {
  return {
    id: 1,
    provider: "gemini",
    isActive: true,
    providerSpecificData: {},
  };
}

describe("/v1/models kind normalization (sweep 2026-11-16, item 5)", () => {
  it("lists gemini-2.5-pro/flash/flash-lite as LLMs despite their duplicate stt entries", async () => {
    db.getProviderConnections.mockResolvedValue([geminiConnection()]);
    const models = await buildModelsList(["llm"]);
    const ids = models.map((m) => m.id);
    for (const modelId of ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"]) {
      expect(ids.some((id) => id.endsWith(`/${modelId}`))).toBe(true);
    }
  });

  it("keeps genuine non-LLM static models out of the LLM list", async () => {
    db.getProviderConnections.mockResolvedValue([geminiConnection()]);
    const models = await buildModelsList(["llm"]);
    const ids = models.map((m) => m.id);
    expect(ids.some((id) => id.endsWith("/gemini-embedding-001"))).toBe(false);
    expect(ids.some((id) => id.endsWith("/gemini-2.5-flash-image"))).toBe(false);
    expect(ids.some((id) => id.endsWith("/gemini-2.5-flash-preview-tts"))).toBe(false);
  });

  it("still lists the embedding model under the embedding filter", async () => {
    db.getProviderConnections.mockResolvedValue([geminiConnection()]);
    const models = await buildModelsList(["embedding"]);
    const ids = models.map((m) => m.id);
    expect(ids.some((id) => id.endsWith("/gemini-embedding-001"))).toBe(true);
  });

  it("infers stt/embedding kinds for unknown dynamic ids instead of defaulting to LLM", async () => {
    db.getProviderConnections.mockResolvedValue([{
      id: 1,
      provider: "openai",
      isActive: true,
      providerSpecificData: {
        enabledModels: ["whisper-large-v3", "bge-m3", "voyage-3-large", "gpt-4o"],
      },
    }]);
    const llm = await buildModelsList(["llm"]);
    const llmIds = llm.map((m) => m.id);
    expect(llmIds.some((id) => id.endsWith("/whisper-large-v3"))).toBe(false);
    expect(llmIds.some((id) => id.endsWith("/bge-m3"))).toBe(false);
    expect(llmIds.some((id) => id.endsWith("/voyage-3-large"))).toBe(false);
    expect(llmIds.some((id) => id.endsWith("/gpt-4o"))).toBe(true);

    const stt = await buildModelsList(["stt"]);
    expect(stt.map((m) => m.id).some((id) => id.endsWith("/whisper-large-v3"))).toBe(true);
    const embedding = await buildModelsList(["embedding"]);
    const embIds = embedding.map((m) => m.id);
    expect(embIds.some((id) => id.endsWith("/bge-m3"))).toBe(true);
    expect(embIds.some((id) => id.endsWith("/voyage-3-large"))).toBe(true);
  });
});
