// Cloudflare Workers AI pricing (pro.29, item E follow-up): per-model
// $/1M-token rates from the official pricing page
// https://developers.cloudflare.com/workers-ai/platform/pricing/ (updated
// 2026-11-18). Workers AI bills in Neurons ($0.011/1,000; 10,000 free/day),
// but the page publishes the token-equivalent rate per model, which is what
// Pro's token-based cost model uses. `cached` is set ONLY where Cloudflare
// publishes a cached-input rate. Run from tests/:
//   bun x vitest run unit/cloudflare-ai-pricing.test.js
import { describe, it, expect } from "vitest";
import { getPricingForModel, calculateCostFromTokens, PROVIDER_PRICING } from "../../open-sse/providers/pricing.js";

// Expected rates, copied from the official page (2026-11-18). If Cloudflare
// changes a rate, update BOTH this table and PROVIDER_PRICING together.
const EXPECTED = {
  "@cf/meta/llama-3.2-1b-instruct": { input: 0.027, output: 0.201 },
  "@cf/meta/llama-3.2-3b-instruct": { input: 0.051, output: 0.335 },
  "@cf/meta/llama-3.1-8b-instruct-fp8-fast": { input: 0.045, output: 0.384 },
  "@cf/meta/llama-3.1-8b-instruct-fp8": { input: 0.152, output: 0.287 },
  "@cf/mistralai/mistral-small-3.1-24b-instruct": { input: 0.351, output: 0.555 },
  "@cf/meta/llama-3.1-70b-instruct-fp8-fast": { input: 0.293, output: 2.253 },
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { input: 0.293, output: 2.253 },
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b": { input: 0.497, output: 4.881 },
  "@cf/deepseek-ai/deepseek-v4-flash-0731": { input: 0.440, output: 1.320, cached: 0.014 },
  "@cf/deepseek-ai/deepseek-v4-pro-0813": { input: 1.320, output: 3.960, cached: 0.044 },
  "@cf/deepseek-ai/deepseek-v4.1-flash-1017": { input: 0.300, output: 1.200, cached: 0.006 },
  "@cf/moonshotai/kimi-k2.6": { input: 0.950, output: 4.000, cached: 0.160 },
  "@cf/moonshotai/kimi-k2.7-code": { input: 0.950, output: 4.000, cached: 0.190 },
  "@cf/zai-org/glm-4.7-flash": { input: 0.060, output: 0.400 },
  "@cf/qwen/qwq-32b": { input: 0.660, output: 1.000 },
  "@cf/qwen/qwen2.5-coder-32b-instruct": { input: 0.660, output: 1.000 },
  "@cf/qwen/qwen3.8-27b": { input: 0.450, output: 3.200 },
  "@cf/qwen/qwen3-30b-a3b-fp8": { input: 0.051, output: 0.335 },
  "@cf/openai/gpt-oss-120b": { input: 0.350, output: 0.750 },
  "@cf/openai/gpt-oss-20b": { input: 0.200, output: 0.300 },
  "@cf/meta/llama-4-scout-17b-16e-instruct": { input: 0.270, output: 0.850 },
  "@cf/meta/llama-3.2-11b-vision-instruct": { input: 0.049, output: 0.676 },
  "@cf/meta/llama-guard-3-8b": { input: 0.484, output: 0.030 },
  "@cf/google/gemma-4-26b-a4b-it": { input: 0.100, output: 0.300 },
  "@cf/aisingapore/gemma-sea-lion-v4-27b-it": { input: 0.351, output: 0.555 },
  "@cf/nvidia/nemotron-3-120b-a12b": { input: 0.500, output: 1.500 },
  "@cf/zai-org/glm-5.2": { input: 1.400, output: 4.400, cached: 0.260 },
  "@cf/zai-org/glm-5.3": { input: 1.400, output: 4.400, cached: 0.260 },
  "@cf/zai-org/glm-5.3-flash": { input: 0.150, output: 0.500, cached: 0.030 },
  "@cf/ibm-granite/granite-4.0-h-micro": { input: 0.017, output: 0.112 },
  "@cf/thinkingmachines/inkling-2-small": { input: 0.300, output: 1.000, cached: 0.100 },
  "@cf/daily-co/phonellm-mini-alpha-2": { input: 0.060, output: 0.240 },
  "@cf/cloudflare/clef-flash": { input: 0.038, output: 0 },
  "@cf/cloudflare/clef": { input: 0.240, output: 0 },
  "@cf/cloudflare/clef-omni": { input: 0.150, output: 0 },
  "@cf/cloudflare/clairic": { input: 0.100, output: 0 },
  "@cf/cloudflare/clairic-flash": { input: 0.100, output: 0 },
};

// Registry models Cloudflare publishes NO token rate for — they must stay
// unpriced (null → $0), not carry a guessed rate.
const UNPRICED_CHAT = [
  "@cf/meta-llama/llama-2-7b-chat-hf-lora",
  "@cf/google/gemma-2b-it-lora",
  "@cf/google/gemma-7b-it-lora",
  "@cf/mistral/mistral-7b-instruct-v0.2-lora",
  "@cf/swiss-ai/apertus-v1.5-8b",
  "@cf/utter-project/eurollm-9b-it",
];
const UNPRICED_IMAGE = [
  "@cf/black-forest-labs/flux-2-klein-9b",
  "@cf/black-forest-labs/flux-2-klein-4b",
  "@cf/black-forest-labs/flux-2-dev",
  "@cf/leonardo/lucid-origin",
  "@cf/leonardo/phoenix-1.0",
  "@cf/black-forest-labs/flux-1-schnell",
  "@cf/bytedance/stable-diffusion-xl-lightning",
  "@cf/lykon/dreamshaper-8-lcm",
  "@cf/runwayml/stable-diffusion-v1-5-inpainting",
  "@cf/stabilityai/stable-diffusion-xl-base-1.0",
];

describe("cloudflare-ai pricing (pro.29, official rates 2026-11-18)", () => {
  it("prices all 37 models with a published token rate", () => {
    expect(Object.keys(PROVIDER_PRICING["cloudflare-ai"])).toHaveLength(37);
    for (const [model, expected] of Object.entries(EXPECTED)) {
      expect(getPricingForModel("cloudflare-ai", model)).toEqual(expected);
    }
  });

  it("cost math: 1M in + 1M out on llama-3.2-1b = $0.228", () => {
    const pricing = getPricingForModel("cloudflare-ai", "@cf/meta/llama-3.2-1b-instruct");
    expect(calculateCostFromTokens({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }, pricing)).toBeCloseTo(0.228, 6);
  });

  it("cached input uses the published cached rate (deepseek-v4-flash)", () => {
    const pricing = getPricingForModel("cloudflare-ai", "@cf/deepseek-ai/deepseek-v4-flash-0731");
    // 1M cached + 1M fresh in + 1M out = 0.014 + 0.440 + 1.320
    expect(calculateCostFromTokens({ prompt_tokens: 2_000_000, cached_tokens: 1_000_000, completion_tokens: 1_000_000 }, pricing)).toBeCloseTo(1.774, 6);
  });

  it("unpriced chat/LoRA models stay null (no guessed rate)", () => {
    for (const model of UNPRICED_CHAT) {
      expect(getPricingForModel("cloudflare-ai", model)).toBeNull();
    }
  });

  it("image models stay null (per-tile billing, not per-token)", () => {
    for (const model of UNPRICED_IMAGE) {
      expect(getPricingForModel("cloudflare-ai", model)).toBeNull();
    }
  });

  it("every priced model is in the registry and every registry chat/systemone model is either priced or listed unpriced", async () => {
    const reg = await import("../../open-sse/providers/registry/cloudflare-ai.js");
    const def = reg.default || reg;
    const ids = (def.models || []).map((x) => (typeof x === "string" ? x : x.id));
    expect(ids).toHaveLength(53);
    const priced = new Set(Object.keys(EXPECTED));
    const unpriced = new Set([...UNPRICED_CHAT, ...UNPRICED_IMAGE]);
    for (const id of ids) {
      expect(priced.has(id) || unpriced.has(id)).toBe(true);
    }
  });
});
