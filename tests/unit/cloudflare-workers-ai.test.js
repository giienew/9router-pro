// Cloudflare Workers AI provider (item E, pro.29 batch).
//
// The provider already existed in the registry; this file locks the wiring
// that makes it actually work live, plus the model list refreshed from the
// live Workers AI catalogue (GET /client/v4/accounts/{id}/ai/models/search,
// 2026-11-19) — the OpenAI-compatible /ai/v1/models route answers 405, so
// the catalogue endpoint is the only live feed.
//
// Live facts locked here (probed from the VPS on 2026-11-19):
// - POST /ai/v1/chat/completions with Bearer token + {accountId} URL returns
//   200 (llama-3.2-1b-instruct replied "OK").
// - @cf/meta/llama-3.1-8b-instruct-awq is 410 deprecated; @cf/moonshotai/kimi-k2.5
//   403s (redirects to paid kimi-k2.6); @cf/runwayml/stable-diffusion-v1-5-img2img
//   403s "not allowed" and is absent from the catalogue — all three are out.
// - @cf/meta/llama-3.1-8b-instruct-fp8-fast and llama-3.1-70b-instruct-fp8-fast
//   are NOT in the catalogue but still answer 200 live, so they stay.
// - Paid-only on a Workers Free account (403): glm-5.3, deepseek-v4-flash-0731,
//   deepseek-v4-pro-0813, kimi-k2.7-code — they stay in the registry because
//   the catalogue lists them and paid accounts can call them.
import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS, PROVIDER_MEDIA } from "../../open-sse/providers/index.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

const ENTRY = REGISTRY.find((e) => e.id === "cloudflare-ai");
const CRED = { apiKey: "sk-test-CFTOKEN", providerSpecificData: { accountId: "ACC123" } };

// Every Text Generation model on the live catalogue (2026-11-19) that the
// registry must carry, plus the two feed-absent-but-live fp8-fast aliases.
const LIVE_TEXT_GENERATION = [
  "@cf/aisingapore/gemma-sea-lion-v4-27b-it",
  "@cf/cloudflare/clairic",
  "@cf/cloudflare/clairic-flash",
  "@cf/cloudflare/clef",
  "@cf/cloudflare/clef-flash",
  "@cf/cloudflare/clef-omni",
  "@cf/daily-co/phonellm-mini-alpha-2",
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
  "@cf/deepseek-ai/deepseek-v4-flash-0731",
  "@cf/deepseek-ai/deepseek-v4-pro-0813",
  "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
  "@cf/google/gemma-2b-it-lora",
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/google/gemma-7b-it-lora",
  "@cf/ibm-granite/granite-4.0-h-micro",
  "@cf/meta-llama/llama-2-7b-chat-hf-lora",
  "@cf/meta/llama-3.1-8b-instruct-fp8",
  "@cf/meta/llama-3.2-11b-vision-instruct",
  "@cf/meta/llama-3.2-1b-instruct",
  "@cf/meta/llama-3.2-3b-instruct",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/meta/llama-guard-3-8b",
  "@cf/mistral/mistral-7b-instruct-v0.2-lora",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
  "@cf/moonshotai/kimi-k2.6",
  "@cf/moonshotai/kimi-k2.7-code",
  "@cf/nvidia/nemotron-3-120b-a12b",
  "@cf/openai/gpt-oss-120b",
  "@cf/openai/gpt-oss-20b",
  "@cf/qwen/qwen2.5-coder-32b-instruct",
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/qwen/qwen3.8-27b",
  "@cf/qwen/qwq-32b",
  "@cf/swiss-ai/apertus-v1.5-8b",
  "@cf/thinkingmachines/inkling-2-small",
  "@cf/utter-project/eurollm-9b-it",
  "@cf/zai-org/glm-4.7-flash",
  "@cf/zai-org/glm-5.2",
  "@cf/zai-org/glm-5.3",
  "@cf/zai-org/glm-5.3-flash",
];

// Dead on the live account / absent from the catalogue: must NOT be registered.
const DEAD_MODELS = [
  "@cf/meta/llama-3.1-8b-instruct-awq",
  "@cf/moonshotai/kimi-k2.5",
  "@cf/runwayml/stable-diffusion-v1-5-img2img",
];

describe("cloudflare-ai registry entry", () => {
  it("is registered as a free-tier apikey provider with the cf alias", () => {
    expect(ENTRY).toBeDefined();
    expect(ENTRY.category).toBe("freeTier");
    expect(ENTRY.hasFree).toBe(true);
    expect(ENTRY.authType).toBe("apikey");
    expect(ENTRY.alias).toBe("cloudflare-ai");
    expect(ENTRY.aliases).toContain("cf");
    expect(ENTRY.display.name).toBe("Cloudflare");
  });

  it("points chat at the account-scoped OpenAI-compatible endpoint", () => {
    expect(ENTRY.transport.baseUrl).toBe(
      "https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1/chat/completions",
    );
    expect(ENTRY.transport.thinkingFormat).toBe("openai");
  });

  it("declares llm + image + systemone service kinds", () => {
    expect(ENTRY.serviceKinds).toContain("llm");
    expect(ENTRY.serviceKinds).toContain("image");
    expect(ENTRY.serviceKinds).toContain("systemone");
    expect(ENTRY.systemoneConfig.baseUrl).toBe(
      "https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run/{model}",
    );
    expect(ENTRY.systemoneConfig.authHeader).toBe("bearer");
    expect(ENTRY.imageConfig.baseUrl).toBe("https://api.cloudflare.com/client/v4/accounts");
  });

  it("builds into the runtime PROVIDERS map with the openai format default", () => {
    expect(PROVIDERS["cloudflare-ai"]).toBeDefined();
    expect(PROVIDERS["cloudflare-ai"].format).toBe("openai");
    expect(PROVIDERS["cloudflare-ai"].baseUrl).toBe(ENTRY.transport.baseUrl);
    expect(PROVIDER_MEDIA["cloudflare-ai"]).toBeDefined();
    expect(PROVIDER_MEDIA["cloudflare-ai"].systemoneConfig).toBeDefined();
    expect(PROVIDER_MEDIA["cloudflare-ai"].imageConfig).toBeDefined();
  });
});

describe("cloudflare-ai transport (DefaultExecutor)", () => {
  it("substitutes {accountId} from providerSpecificData into the chat URL", () => {
    const ex = new DefaultExecutor("cloudflare-ai");
    const url = ex.buildUrl("@cf/meta/llama-3.2-1b-instruct", false, 0, CRED);
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/ACC123/ai/v1/chat/completions",
    );
    expect(ex.buildUrl("@cf/meta/llama-3.2-1b-instruct", true, 0, CRED)).toBe(url);
  });

  it("refuses to build a URL without an accountId", () => {
    const ex = new DefaultExecutor("cloudflare-ai");
    expect(() =>
      ex.buildUrl("@cf/meta/llama-3.2-1b-instruct", false, 0, { apiKey: "x", providerSpecificData: {} }),
    ).toThrow("requires accountId in providerSpecificData");
  });

  it("sends the API token as a Bearer header", () => {
    const ex = new DefaultExecutor("cloudflare-ai");
    const headers = ex.buildHeaders(CRED, false);
    expect(headers.Authorization).toBe("Bearer sk-test-CFTOKEN");
    expect(headers["Content-Type"]).toBe("application/json");
  });
});

describe("cloudflare-ai model list (live catalogue 2026-11-19)", () => {
  const ids = ENTRY.models.map((m) => m.id);

  it("has unique ids, all under @cf/ with a display name", () => {
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of ENTRY.models) {
      expect(m.id.startsWith("@cf/")).toBe(true);
      expect(typeof m.name).toBe("string");
      expect(m.name.length).toBeGreaterThan(0);
    }
  });

  it("carries every Text Generation model from the live catalogue", () => {
    for (const id of LIVE_TEXT_GENERATION) expect(ids).toContain(id);
  });

  it("keeps the two feed-absent aliases that still answer 200 live", () => {
    expect(ids).toContain("@cf/meta/llama-3.1-8b-instruct-fp8-fast");
    expect(ids).toContain("@cf/meta/llama-3.1-70b-instruct-fp8-fast");
  });

  it("drops the models that are dead or absent from the live catalogue", () => {
    for (const id of DEAD_MODELS) expect(ids).not.toContain(id);
  });

  it("marks the decision models as systemone with short upstream ids", () => {
    const sys = Object.fromEntries(
      ENTRY.models.filter((m) => m.kind === "systemone").map((m) => [m.id, m.upstreamModelId]),
    );
    expect(sys).toEqual({
      "@cf/cloudflare/clef-flash": "clef-flash",
      "@cf/cloudflare/clef": "clef",
      "@cf/cloudflare/clef-omni": "clef-omni",
      "@cf/cloudflare/clairic": "clairic",
      "@cf/cloudflare/clairic-flash": "clairic-flash",
    });
  });

  it("marks every image model with kind image and a size param", () => {
    const images = ENTRY.models.filter((m) => m.kind === "image");
    expect(images.length).toBe(10);
    for (const m of images) expect(m.params).toContain("size");
    expect(images.map((m) => m.id)).toContain("@cf/black-forest-labs/flux-2-klein-9b");
    expect(images.map((m) => m.id)).toContain("@cf/runwayml/stable-diffusion-v1-5-inpainting");
  });

  it("exposes the same list through PROVIDER_MODELS", () => {
    const runtimeIds = (PROVIDER_MODELS["cloudflare-ai"] || []).map((m) => m.id);
    expect(runtimeIds.sort()).toEqual([...ids].sort());
  });
});
