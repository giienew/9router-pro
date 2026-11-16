// OpenCode Go's claude-haiku-5-5 rejects the budget-shaped thinking the global
// *claude*haiku* capability pattern used to emit:
//   400 "thinking.type.enabled" is not supported for this model.
//       Use "thinking.type.adaptive" and "output_config.effort" to control thinking
// Upstream 0.5.119 made haiku-5-5 adaptive-only GLOBALLY (explicit caps row), so
// every provider now resolves claude-adaptive for this id — the old
// provider-scoped override is subsumed by the global row. These tests drive the
// real applyThinking() so a regression in the capability entry shows up as the old shape.
import { describe, expect, it } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// A Claude-wire request asking for thinking on (what Claude Code sends).
const claudeWireBody = () => ({
  model: "claude-haiku-5-5",
  max_tokens: 4096,
  thinking: { type: "enabled", budget_tokens: 8000 },
  messages: [{ role: "user", content: "hi" }],
});

describe("opencode-go claude-haiku-5-5 thinking shape", () => {
  it("capability row selects adaptive for this model on every provider", () => {
    expect(getCapabilitiesForModel("opencode-go", "claude-haiku-5-5").thinkingFormat).toBe("claude-adaptive");
    expect(getCapabilitiesForModel(undefined, "claude-haiku-5-5").thinkingFormat).toBe("claude-adaptive");
    expect(getCapabilitiesForModel("claude", "claude-haiku-5-5").thinkingFormat).toBe("claude-adaptive");
  });

  it("emits thinking.type=adaptive + output_config.effort (never type=enabled)", () => {
    const body = applyThinking("claude", "claude-haiku-5-5", claudeWireBody(), "opencode-go");

    expect(body.thinking?.type).toBe("adaptive");
    expect(body.thinking).not.toHaveProperty("budget_tokens");
    expect(body.output_config?.effort).toBeTruthy();
  });

  it("other haiku ids keep the budget shape for the same wire", () => {
    // Regression guard: the adaptive row covers haiku-5-5 exactly — older
    // haiku ids still resolve through the global *claude*haiku* budget pattern.
    const body = applyThinking("claude", "claude-haiku-4-5-20251001", {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      thinking: { type: "enabled", budget_tokens: 8000 },
      messages: [{ role: "user", content: "hi" }],
    }, "claude");

    expect(body.thinking?.type).toBe("enabled");
    expect(body.thinking?.budget_tokens).toBeGreaterThan(0);
    expect(body.output_config).toBeUndefined();
  });
});
