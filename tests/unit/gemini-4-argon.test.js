import { describe, expect, it } from "vitest";

import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

describe("Gemini 4 Hydrogen (Sonar) capabilities", () => {
  // Live-verified 2026-11-19: gemini-4-hydrogen-sonar is the only gemini-4
  // model enabled with quota on the owner's Antigravity account (the tiered
  // carbon/argon entries 404 upstream in every form and were removed from
  // the registry). Capabilities come from the *gemini-4* pattern, so the
  // sonar variant inherits the family's level-based reasoning.
  it.each(["gemini", "vertex", "antigravity"])("declares level-based always-on reasoning on %s", (provider) => {
    const model = provider === "antigravity" ? "gemini-4-hydrogen-sonar" : "gemini-4-argon";
    const caps = getCapabilitiesForModel(provider, model);
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("gemini-level");
    expect(caps.thinkingCanDisable).toBe(false);
    expect(caps.contextWindow).toBe(1048576);
    expect(caps.maxOutput).toBe(65536);
    expect(getThinkingLevels(provider, model)).toEqual(["low", "medium", "high"]);
  });
});

describe("Gemini 4 Argon thinking clamp", () => {
  // Argon rejects thinkingLevel "minimal" (and thinkingBudget) with HTTP 400 —
  // every path that would emit "minimal" must clamp to the lowest supported level.
  it("clamps an explicit reasoning_effort none to low", () => {
    const body = { reasoning_effort: "none" };
    applyThinking("gemini", "gemini-4-argon", body, "vertex");
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low", includeThoughts: true });
  });

  it("clamps a small thinking budget (minimal after conversion) to low", () => {
    const body = { thinking: { type: "enabled", budget_tokens: 512 } };
    applyThinking("gemini", "gemini-4-argon", body, "vertex");
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low", includeThoughts: true });
  });

  it("passes supported levels through untouched", () => {
    const body = { reasoning_effort: "high" };
    applyThinking("gemini", "gemini-4-argon", body, "vertex");
    expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe("high");
  });

  it("keeps minimal for Gemini 3 models (regression guard)", () => {
    const body = { reasoning_effort: "none" };
    applyThinking("gemini", "gemini-3.8-flash", body, "gemini");
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "minimal", includeThoughts: false });
  });
});

describe("Gemini 4 Hydrogen (Sonar) Antigravity model", () => {
  // The sonar variant is used bare — no tier suffix. A tiered suffix
  // (gemini-4-hydrogen-sonar(high)) 404s upstream (live probe 2026-11-19),
  // and the tiered carbon/argon entries were removed for the same reason.
  it("resolves to the bare model id upstream (no tier suffix)", () => {
    expect(getModelUpstreamId("ag", "gemini-4-hydrogen-sonar")).toBe("gemini-4-hydrogen-sonar");
  });

  it("passes the model through transformRequest unchanged", () => {
    const body = {
      model: "gemini-4-hydrogen-sonar",
      request: {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        generationConfig: {},
      },
    };
    const finalBody = new AntigravityExecutor().transformRequest(
      "gemini-4-hydrogen-sonar",
      body,
      true,
      { projectId: "project", connectionId: "connection" }
    );
    expect(finalBody.model).toBe("gemini-4-hydrogen-sonar");
  });
});
