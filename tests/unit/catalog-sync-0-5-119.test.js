import { describe, expect, it } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { CLAUDE_CLI_VERSION } from "../../open-sse/providers/shared.js";

// Catalog sync — upstream decolua/9router v0.5.109 → v0.5.119 (2026-11-16
// sweep, item 1). Providers/models already present in Pro at 0.5.109+
// (runcrate, nace, ollama-local, mimo-v2.6, deepseek-flash mapping,
// /v1/models thinking_levels, engines.node floor) are NOT re-asserted here
// except where the sync adds to them.

function entry(id) {
  return REGISTRY.find((r) => r.id === id);
}

function modelIds(aliasOrId) {
  return (PROVIDER_MODELS[aliasOrId] || []).map((m) => m.id);
}

describe("catalog sync 0.5.109 → 0.5.119 — new providers", () => {
  it("registers Synthetic (syn) as an OpenAI-compatible provider", () => {
    const syn = entry("synthetic");
    expect(syn).toBeDefined();
    expect(syn.aliases).toContain("syn");
    expect(syn.transport.baseUrl).toBe("https://api.synthetic.new/openai/v1/chat/completions");
    expect(syn.transport.validateUrl).toBe("https://api.synthetic.new/v2/quotas");
    expect(syn.passthroughModels).toBe(true);
    const ids = modelIds("synthetic");
    expect(ids).toContain("hf:zai-org/GLM-5.3");
    expect(ids).toContain("hf:deepseek-ai/DeepSeek-V4.1-Flash");
    expect(ids).toContain("hf:openai/gpt-oss-120b");
  });

  it("registers SenseNova (Intl) on the .ai host, separate from the .cn entry", () => {
    const intl = entry("sensenova-intl");
    expect(intl).toBeDefined();
    expect(intl.transport.baseUrl).toBe("https://token.sensenova.ai/v1/chat/completions");
    expect(intl.transport.validateUrl).toBe("https://token.sensenova.ai/v1/models");
    expect(intl.transport.quirks.reasoningAliasFields).toBe(true);
    const ids = modelIds("sensenova-intl");
    expect(ids).toContain("sensenova-6.8-flash");
    expect(ids).toContain("sensenova-6.8-flash-lite");
    expect(ids).toContain("sensenova-u1-fast");
    // The China entry keeps its own host and catalog.
    expect(entry("sensenova").transport.baseUrl).toContain("token.sensenova.cn");
  });
});

describe("catalog sync 0.5.109 → 0.5.119 — model additions", () => {
  it("adds Claude Fable 5.2 + Haiku 5.5 and retires Fable 5.1 from the catalog", () => {
    const ids = modelIds("cc");
    expect(ids).toContain("claude-fable-5-2");
    expect(ids).toContain("claude-haiku-5-5");
    expect(ids).not.toContain("claude-fable-5-1");
    // Retirement is list-only: caps stay so an existing 5.1 config still
    // translates (upstream keeps the caps row too).
    expect(getCapabilitiesForModel("claude", "claude-fable-5-1")).toMatchObject({
      contextWindow: 1000000,
      maxOutput: 128000,
    });
    expect(getCapabilitiesForModel("claude", "claude-fable-5-2")).toMatchObject({
      contextWindow: 1000000,
      maxOutput: 128000,
    });
  });

  it("retires Fable 5.1 from the OpenCode Zen catalog too", () => {
    expect(modelIds("ocz")).not.toContain("claude-fable-5-1");
    expect(modelIds("ocz")).toContain("claude-fable-5");
  });

  it("adds Gemini 4 Hydrogen (Sonar) to Antigravity; Carbon tiers removed (404 upstream)", () => {
    // Live-verified 2026-11-19: gemini-4-hydrogen-sonar is the only
    // gemini-4 model enabled with quota on the owner's Antigravity
    // account. The Carbon tiered entries (high/medium/low + bare) 404
    // upstream in every form and were removed from the registry.
    const ids = modelIds("ag");
    expect(ids).toContain("gemini-4-hydrogen-sonar");
    for (const id of ["gemini-4-carbon-high", "gemini-4-carbon-medium", "gemini-4-carbon-low", "gemini-4-carbon"]) {
      expect(ids).not.toContain(id);
    }
  });

  it("adds Gemini 4 Carbon + Fable 5.2 to CommandCode", () => {
    const ids = modelIds("commandcode");
    expect(ids).toContain("google/gemini-4-carbon");
    expect(ids).toContain("claude-fable-5-2");
  });

  it("adds GPT Image 2.6 models to Codex and advertises CLI 0.167.1", () => {
    const ids = modelIds("cx");
    expect(ids).toContain("gpt-image-2.6-flare");
    expect(ids).toContain("gpt-image-2.6-sunburst");
    expect(entry("codex").transport.cliVersion).toBe("0.167.1");
  });

  it("adds SenseNova 6.8 Flash + GLM-5.3 to the China entry", () => {
    const ids = modelIds("sensenova");
    expect(ids).toContain("sensenova-6.8-flash");
    expect(ids).toContain("glm-5.3");
  });

  it("keeps Nace at drex-max + drex-v2.0 — bare drex is the alias, not a model", () => {
    // Upstream 0.5.119 nace.js lists only drex-max + drex-v2.0; "drex" is
    // the provider alias (aliases: ["drex"]). A bare drex model row would
    // be a phantom id no upstream catalog serves.
    expect(modelIds("nace")).toEqual(["drex-max", "drex-v2.0"]);
    expect(entry("nace").aliases).toContain("drex");
  });

  it("adds MiMo v2.6 + v2.5 ASR to Xiaomi Token Plan", () => {
    const models = PROVIDER_MODELS["xiaomi-tokenplan"] || [];
    const ids = models.map((m) => m.id);
    expect(ids).toContain("mimo-v2.6-pro");
    expect(ids).toContain("mimo-v2.6-flash");
    expect(ids).toContain("mimo-v2.5-asr");
    expect(models.find((m) => m.id === "mimo-v2.5-asr").kind).toBe("stt");
  });
});

describe("catalog sync 0.5.109 → 0.5.119 — pricing + CLI version", () => {
  it("bills gemini-4 models at $2/$10 instead of the generic gemini-* rate", () => {
    expect(getPricingForModel("antigravity", "gemini-4-carbon-high")).toMatchObject({ input: 2.0, output: 10.0 });
    expect(getPricingForModel("antigravity", "gemini-4-argon-medium")).toMatchObject({ input: 2.0, output: 10.0 });
  });

  it("prices Fable 5.2 at $8/$40 and Haiku 5.5 at $0.10/$0.50", () => {
    expect(getPricingForModel("claude", "claude-fable-5-2")).toMatchObject({ input: 8.0, output: 40.0 });
    expect(getPricingForModel("claude", "claude-haiku-5-5")).toMatchObject({ input: 0.1, output: 0.5 });
  });

  it("advertises the Claude CLI version at the upstream floor", () => {
    expect(CLAUDE_CLI_VERSION).toBe("2.1.322");
  });
});

describe("catalog sync 0.5.109 → 0.5.119 — round 2 (late catalog report)", () => {
  it("retires Fable 5.1 from the GitHub Copilot catalog too, keeps its $10/$50 price", () => {
    expect(modelIds("gh")).not.toContain("claude-fable-5.1");
    expect(modelIds("gh")).toContain("claude-fable-5");
    expect(getPricingForModel("claude", "claude-fable-5-1")).toMatchObject({ input: 10.0, output: 50.0 });
  });

  it("makes Haiku 5.5 adaptive-only globally, not just per-provider", () => {
    expect(getCapabilitiesForModel("claude", "claude-haiku-5-5")).toMatchObject({
      thinkingFormat: "claude-adaptive",
      contextWindow: 1000000,
      maxOutput: 128000,
    });
  });

  it("publishes SenseNova (Intl) caps at 256K/64K for the three chat models", () => {
    for (const id of ["sensenova-6.8-flash", "sensenova-6.8-flash-lite", "sensenova-6.7-flash-lite"]) {
      expect(getCapabilitiesForModel("sensenova-intl", id)).toMatchObject({
        contextWindow: 262144,
        maxOutput: 65536,
      });
    }
  });

  it("refreshes the NVIDIA NIM catalog with the 0.5.119 models + transport", () => {
    const ids = modelIds("nvidia");
    for (const id of [
      "nvidia/nemotron-3.5-lightning-30b-a3b",
      "nvidia/nemotron-3.5-bolt-e4b",
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
      "poolside/laguna-xs-2.1",
      "meta/llama-guard-4-12b",
      "nvidia/riva-translate-4b-instruct-v2",
      "meta/llama-3.3-70b-instruct",
    ]) expect(ids).toContain(id);
    expect(ids.filter((id) => id === "nvidia/nemotron-3-ultra-550b-a55b")).toHaveLength(1);
    expect(entry("nvidia").transport.timeoutMs).toBe(90000);
    expect(entry("nvidia").transport.quirks.dropClientMetadata).toBe(true);
    expect(getCapabilitiesForModel("nvidia", "nvidia/nemotron-3.5-lightning-30b-a3b")).toMatchObject({
      tools: false,
      reasoning: true,
      contextWindow: 128000,
      maxOutput: 8192,
    });
  });

  it("gives the SenseNova China entry the reasoning-alias quirk + Intl notice", () => {
    expect(entry("sensenova").transport.quirks.reasoningAliasFields).toBe(true);
    expect(entry("sensenova").display.notice.text).toContain("SenseNova (Intl)");
  });

  it("moves OpenCode Go off the retired /zen/go/v1 endpoints", () => {
    const oc = entry("opencode-go");
    expect(oc.transport.baseUrl).toBe("https://opencode.ai/inference/go/openai/v1/chat/completions");
    expect(oc.transport.usage.url).toBe("https://opencode.ai/inference/go/v1/usage");
    expect(oc.modelsFetcher.url).toBe("https://opencode.ai/inference/go/v1/models");
    const claude = oc.transports.find((t) => t.format === "claude");
    expect(claude.baseUrl).toBe("https://opencode.ai/inference/go/anthropic/v1/messages");
    expect(claude.thinkingFormat).toBe("claude-adaptive");
    const responses = oc.transports.find((t) => t.format === "openai-responses");
    expect(responses.baseUrl).toBe("https://opencode.ai/inference/go/openai/v1/responses");
  });

  it("bumps CommandCode to 1.88.5 and marks it passthrough", () => {
    const cc = entry("commandcode");
    expect(cc.transport.headers["x-command-code-version"]).toBe("1.88.5");
    expect(cc.passthroughModels).toBe(true);
  });

  it("points Codex image generation at the chatgpt.com images endpoint", () => {
    expect(entry("codex").imageConfig.baseUrl).toBe("https://chatgpt.com/backend-api/codex/images/generations");
  });

  it("adds the ClinePass quota-tracker keys", () => {
    const cp = entry("clinepass");
    expect(cp.transport.usage.url).toBe("https://api.cline.bot/api/v1/users/me/plan/usage-limits");
    expect(cp.features.usage).toBe(true);
    expect(cp.features.usageApikey).toBe(true);
  });
});
