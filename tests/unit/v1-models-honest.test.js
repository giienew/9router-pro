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

describe("/v1/models honesty (G2)", () => {
  it("rejects instead of falling through to the static catalog on a DB error", async () => {
    db.getProviderConnections.mockRejectedValue(new Error("database is locked"));
    await expect(buildModelsList(["llm"])).rejects.toThrow(/Failed to load provider connections/);
  });

  it("lists no static-catalog, combo, or variant ids when zero connections exist", async () => {
    db.getProviderConnections.mockResolvedValue([]);
    db.getCombos.mockResolvedValue([{ name: "my-combo", models: ["dahl/deepseek"] }]);
    db.getInjectVariants.mockResolvedValue({ "my-variant": { model: "dahl/deepseek", enabled: true } });
    const models = await buildModelsList(["llm"]);
    const ids = models.map((m) => m.id);
    expect(ids).not.toContain("my-combo");
    expect(ids).not.toContain("my-variant");
    // No provider/model from the static catalog for a provider with no
    // connection: every remaining id must be a no-auth provider's model
    // (virtual connection) — never a stored-connection provider's.
    expect(ids.filter((id) => id.startsWith("dahl/"))).toEqual([]);
    expect(ids.filter((id) => id.startsWith("kr/"))).toEqual([]);
  });

  it("lists auto: intents as discoverable models when connections exist (G6)", async () => {
    db.getProviderConnections.mockResolvedValue([{
      id: 1, provider: "deepseek", isActive: true,
      providerSpecificData: { enabledModels: ["deepseek-chat"] },
    }]);
    db.getCombos.mockResolvedValue([]);
    db.getInjectVariants.mockResolvedValue({});
    const models = await buildModelsList(["llm"]);
    for (const intent of ["coding", "fast", "cheap", "headroom"]) {
      const entry = models.find((m) => m.id === `auto:${intent}`);
      expect(entry).toMatchObject({ object: "model", owned_by: "auto" });
    }
  });

  it("hides auto: intents when zero connections exist (nothing can serve them)", async () => {
    db.getProviderConnections.mockResolvedValue([]);
    db.getCombos.mockResolvedValue([]);
    db.getInjectVariants.mockResolvedValue({});
    const models = await buildModelsList(["llm"]);
    expect(models.filter((m) => m.id.startsWith("auto:"))).toEqual([]);
  });

  it("still lists a connected provider's models", async () => {
    db.getProviderConnections.mockResolvedValue([{
      id: 1, provider: "deepseek", isActive: true,
      providerSpecificData: { enabledModels: ["deepseek-chat"] },
    }]);
    db.getCombos.mockResolvedValue([]);
    db.getInjectVariants.mockResolvedValue({});
    const models = await buildModelsList(["llm"]);
    expect(models.map((m) => m.id)).toContain("ds/deepseek-chat");
  });
});
