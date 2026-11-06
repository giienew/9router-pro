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

// Seeded `free` combo members (see seedFreeCombo in src/lib/db/migrate.js).
const FREE_COMBO = {
  name: "free",
  models: ["opencode/muse-spark-1.3-contributor-free", "opencode/union-alpha"],
};

describe("/v1/models zero-config free combo", () => {
  it("lists the all-no-auth `free` combo when zero connections exist", async () => {
    db.getProviderConnections.mockResolvedValue([]);
    db.getCombos.mockResolvedValue([FREE_COMBO]);
    db.getInjectVariants.mockResolvedValue({});
    const models = await buildModelsList(["llm"]);
    const entry = models.find((m) => m.id === "free");
    expect(entry).toMatchObject({ object: "model", owned_by: "combo" });
    // And the no-auth provider models themselves are still listed — under
    // the provider's UI alias (opencode publishes as oc/*).
    expect(models.map((m) => m.id)).toContain("oc/muse-spark-1.3-contributor-free");
  });

  it("hides a combo with any stored-provider seat when zero connections exist", async () => {
    db.getProviderConnections.mockResolvedValue([]);
    db.getCombos.mockResolvedValue([
      FREE_COMBO,
      { name: "mixed", models: ["opencode/muse-spark-1.3-contributor-free", "dahl/deepseek"] },
      { name: "nested", models: ["free"] },
    ]);
    db.getInjectVariants.mockResolvedValue({});
    const models = await buildModelsList(["llm"]);
    const ids = models.map((m) => m.id);
    expect(ids).toContain("free");
    expect(ids).not.toContain("mixed");
    // Nested combo names cannot be proven servable without connections.
    expect(ids).not.toContain("nested");
  });

  it("lists a no-auth variant but hides a stored-provider variant with zero connections", async () => {
    db.getProviderConnections.mockResolvedValue([]);
    db.getCombos.mockResolvedValue([]);
    db.getInjectVariants.mockResolvedValue({
      "free-variant": { model: "opencode/union-alpha", enabled: true },
      "paid-variant": { model: "dahl/deepseek", enabled: true },
    });
    const models = await buildModelsList(["llm"]);
    const ids = models.map((m) => m.id);
    expect(ids).toContain("free-variant");
    expect(ids).not.toContain("paid-variant");
  });

  it("still hides auto: intents when zero connections exist", async () => {
    db.getProviderConnections.mockResolvedValue([]);
    db.getCombos.mockResolvedValue([FREE_COMBO]);
    db.getInjectVariants.mockResolvedValue({});
    const models = await buildModelsList(["llm"]);
    expect(models.filter((m) => m.id.startsWith("auto:"))).toEqual([]);
  });
});
