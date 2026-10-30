// P1-17 (part 1): upstream 0.5.111/0.5.112 safe ports — Codex image shim,
// new catalog rows, capability entries, CommandCode 1.88.0 headers data,
// and reasoning_effort max on OpenAI-compatible nodes.
// Run from tests/:
//   bun x vitest run unit/upstream-port-p1-17a.test.js
import { describe, it, expect } from "vitest";
import { resolveCodexImageModels } from "../../open-sse/handlers/imageProviders/codex.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import codexRegistry from "../../open-sse/providers/registry/codex.js";
import commandcodeRegistry from "../../open-sse/providers/registry/commandcode.js";

describe("Codex image shim (upstream dropped gpt-5.6-*-image)", () => {
  it("maps dropped ids to the gpt-6-sol host, keeps tool models on it", () => {
    expect(resolveCodexImageModels("gpt-5.6-sol-image")).toEqual({ responsesModel: "gpt-6-sol", toolModel: null });
    expect(resolveCodexImageModels("gpt-5.6-terra-image")).toEqual({ responsesModel: "gpt-6-sol", toolModel: null });
    expect(resolveCodexImageModels("gpt-5.6-luna-image")).toEqual({ responsesModel: "gpt-6-sol", toolModel: null });
    expect(resolveCodexImageModels("gpt-6-sol-image")).toEqual({ responsesModel: "gpt-6-sol", toolModel: null });
    expect(resolveCodexImageModels("gpt-image-1.5")).toEqual({ responsesModel: "gpt-6-sol", toolModel: "gpt-image-1.5" });
  });

  it("registry keeps old ids and lists the new ones", () => {
    const ids = new Set(codexRegistry.models.map((m) => m.id));
    for (const id of ["gpt-5.6-sol-image", "gpt-5.6-terra-image", "gpt-5.6-luna-image", "gpt-6-sol-image", "gpt-6.1-terra"]) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it("caps mark new and shimmed ids as image models", () => {
    expect(getCapabilitiesForModel("codex", "gpt-6-sol-image").imageOutput).toBe(true);
    expect(getCapabilitiesForModel("codex", "gpt-5.6-sol-image").imageOutput).toBe(true);
    expect(getCapabilitiesForModel("codex", "gpt-6.1-terra").contextWindow).toBe(500000);
  });
});

describe("upstream catalog / caps ports", () => {
  it("kimi-k3.1-pro, deepseek free cap", () => {
    expect(getCapabilitiesForModel(null, "kimi-k3.1-pro").contextWindow).toBe(1048576);
    expect(getCapabilitiesForModel("opencode", "deepseek-v4.1-flash-free").contextWindow).toBe(330000);
  });

  it("CommandCode registry carries 1.88.0 headers and Kimi K3.1 Pro", () => {
    expect(commandcodeRegistry.transport.headers["x-command-code-version"]).toBe("1.88.0");
    expect(commandcodeRegistry.models.some((m) => m.id === "moonshotai/Kimi-K3.1-Pro")).toBe(true);
  });

  it("OpenAI-compatible nodes keep reasoning_effort max for GPT-5.6/6", () => {
    expect(getThinkingLevels("openai-compatible-foo", "gpt-6-sol")).toContain("max");
    expect(getThinkingLevels("openai-compatible-foo", "gpt-5.6-sol")).toContain("max");
  });
});
