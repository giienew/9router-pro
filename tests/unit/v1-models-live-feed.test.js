import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { clearLiveModelFeedCache } from "../../src/lib/liveModelFeed.js";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
  getInjectVariants: vi.fn(async () => ({})),
}));

vi.mock("@/lib/localDb", async (importOriginal) => {
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

const PROVIDER = "openai-compatible-test";
const BASE_URL = "https://gw.example.test/v1";
const API_KEY = "sk-test-1";
const FEED = {
  object: "list",
  data: [
    { id: "model-a", context_length: 65536, max_completion_tokens: 8192 },
    { id: "model-b", context_length: 262144, max_completion_tokens: 32768 },
  ],
};

function connection(overrides = {}) {
  return {
    id: 1,
    provider: PROVIDER,
    isActive: true,
    apiKey: API_KEY,
    providerSpecificData: { baseUrl: BASE_URL, apiKey: API_KEY },
    ...overrides,
  };
}

describe("/v1/models live-feed limits", () => {
  let fetchStub;

  beforeEach(() => {
    clearLiveModelFeedCache();
    fetchStub = vi.fn(async () => ({ ok: true, json: async () => FEED }));
    vi.stubGlobal("fetch", fetchStub);
    db.getCustomModels.mockResolvedValue([]);
    db.getModelAliases.mockResolvedValue({});
    db.getInjectVariants.mockResolvedValue({});
    db.getCombos.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function listWith(conn, combos = []) {
    db.getProviderConnections.mockResolvedValue([conn]);
    db.getCombos.mockResolvedValue(combos);
    return buildModelsList(["llm"]);
  }

  it("lists feed models with the feed's own limits", async () => {
    const models = await listWith(connection());
    expect(models.find((m) => m.id === `${PROVIDER}/model-a`)).toMatchObject({
      context_length: 65536,
      max_completion_tokens: 8192,
    });
    expect(models.find((m) => m.id === `${PROVIDER}/model-b`)).toMatchObject({
      context_length: 262144,
      max_completion_tokens: 32768,
    });
    // The feed is fetched once, at the gateway's /models, with the
    // connection's key and the cross-instance loop-breaker header.
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, options] = fetchStub.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/models`);
    expect(options.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(options.headers["x-9r-internal-models-fetch"]).toBe("1");
  });

  it("feed limits override the static guess for a pinned model", async () => {
    const staticCaps = getCapabilitiesForModel(PROVIDER, "model-a");
    expect(staticCaps.contextWindow).not.toBe(65536);
    const models = await listWith(connection({
      providerSpecificData: { baseUrl: BASE_URL, apiKey: API_KEY, enabledModels: ["model-a"] },
    }));
    expect(models.find((m) => m.id === `${PROVIDER}/model-a`)).toMatchObject({
      context_length: 65536,
      max_completion_tokens: 8192,
      capabilities: expect.objectContaining({ contextWindow: 65536, maxOutput: 8192 }),
    });
  });

  it("a failed feed falls back to the static values and still lists the model", async () => {
    fetchStub.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    const staticCaps = getCapabilitiesForModel(PROVIDER, "model-a");
    const models = await listWith(connection({
      providerSpecificData: { baseUrl: BASE_URL, apiKey: API_KEY, enabledModels: ["model-a"] },
    }));
    const published = models.find((m) => m.id === `${PROVIDER}/model-a`);
    expect(published).toBeDefined();
    expect(published.context_length).toBe(staticCaps.contextWindow);
    expect(published.max_completion_tokens).toBe(staticCaps.maxOutput);
  });

  it("a model absent from the feed keeps the static values", async () => {
    fetchStub.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ id: "model-b", context_length: 262144 }] }),
    });
    const staticCaps = getCapabilitiesForModel(PROVIDER, "model-a");
    const models = await listWith(connection({
      providerSpecificData: { baseUrl: BASE_URL, apiKey: API_KEY, enabledModels: ["model-a"] },
    }));
    expect(models.find((m) => m.id === `${PROVIDER}/model-a`)).toMatchObject({
      context_length: staticCaps.contextWindow,
      max_completion_tokens: staticCaps.maxOutput,
    });
  });

  it("a combo seat takes its window from the feed, not the static guess", async () => {
    const models = await listWith(connection(), [
      { name: "live-combo", models: [`${PROVIDER}/model-a`] },
    ]);
    expect(models.find((m) => m.id === "live-combo")).toMatchObject({
      context_length: 65536,
      max_completion_tokens: 8192,
      capabilities: expect.objectContaining({ contextWindow: 65536, maxOutput: 8192 }),
    });
  });

  it("a nested combo inherits the live limit through the chain", async () => {
    const models = await listWith(connection(), [
      { name: "inner-combo", models: [`${PROVIDER}/model-a`] },
      { name: "outer-combo", models: ["inner-combo"] },
    ]);
    expect(models.find((m) => m.id === "outer-combo")).toMatchObject({
      context_length: 65536,
      max_completion_tokens: 8192,
    });
  });

  it("the feed is cached: a second build does not re-fetch", async () => {
    db.getProviderConnections.mockResolvedValue([connection()]);
    db.getCombos.mockResolvedValue([]);
    await buildModelsList(["llm"]);
    await buildModelsList(["llm"]);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("skipDynamicFetch never touches the network and keeps static values", async () => {
    db.getProviderConnections.mockResolvedValue([connection({
      providerSpecificData: { baseUrl: BASE_URL, apiKey: API_KEY, enabledModels: ["model-a"] },
    })]);
    db.getCombos.mockResolvedValue([]);
    const staticCaps = getCapabilitiesForModel(PROVIDER, "model-a");
    const models = await buildModelsList(["llm"], { skipDynamicFetch: true });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(models.find((m) => m.id === `${PROVIDER}/model-a`)).toMatchObject({
      context_length: staticCaps.contextWindow,
    });
  });
});
