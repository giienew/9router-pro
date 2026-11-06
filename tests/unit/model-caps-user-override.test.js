// User per-model capability overrides (model editor) — runtime layer.
//
// The reported case: stepfun-ai/step-5-preview on NVIDIA NIM is detected
// reasoning-only + 128k by the `*step-*` pattern (no vision), even though
// the model reads images and has a 1M window. chatCore strips image blocks
// whenever caps.vision is false, so the override must reach
// getCapabilitiesForModel itself — not just the dashboard payload.
import { describe, it, expect, afterEach } from "vitest";
import { getCapabilitiesForModel, setUserCapsSource } from "../../open-sse/providers/capabilities.js";

afterEach(() => {
  setUserCapsSource(null);
});

function install(overrides) {
  setUserCapsSource({
    getOverride: (provider, model) => overrides[`${provider}:${model}`] || null,
  });
}

describe("user model overrides in getCapabilitiesForModel", () => {
  it("detects step-5-preview on nvidia as reasoning-only, 128k, no vision (the reported bug)", () => {
    const caps = getCapabilitiesForModel("nvidia", "stepfun-ai/step-5-preview");
    expect(caps.vision).toBe(false);
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("step");
    expect(caps.contextWindow).toBe(128000);
  });

  it("a vision + contextWindow override beats the *step-* pattern but keeps detection for unset fields", () => {
    install({ "nvidia:stepfun-ai/step-5-preview": { vision: true, contextWindow: 1000000 } });
    const caps = getCapabilitiesForModel("nvidia", "stepfun-ai/step-5-preview");
    expect(caps.vision).toBe(true);
    expect(caps.contextWindow).toBe(1000000);
    // Untouched fields still come from the pattern, not the default.
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("step");
    expect(caps.maxOutput).toBe(64000);
  });

  it("an explicit vision:false override turns vision off on a vision model", () => {
    install({ "glm:glm-5.3-flash": { vision: false } });
    const caps = getCapabilitiesForModel("glm", "glm-5.3-flash");
    expect(caps.vision).toBe(false);
    // Everything else stays as the exact entry declares it.
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("zai");
    expect(caps.contextWindow).toBe(1000000);
    expect(caps.maxOutput).toBe(131072);
  });

  it("a contextWindow-only override beats an exact entry's number and nothing else", () => {
    install({ "kiro:claude-opus-5": { contextWindow: 500000 } });
    const caps = getCapabilitiesForModel("kiro", "claude-opus-5");
    expect(caps.contextWindow).toBe(500000);
    expect(caps.vision).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("claude-adaptive");
    expect(caps.maxOutput).toBe(128000);
  });

  it("an override keyed by provider id also applies when the caller passes the UI alias", () => {
    // The row is stored under the provider id; combo seats may call with
    // either spelling, so the source is expected to index both.
    install({ "opencode-go:claude-haiku-5-5": { contextWindow: 400000 } });
    expect(getCapabilitiesForModel("opencode-go", "claude-haiku-5-5").contextWindow).toBe(400000);
  });

  it("a throwing override source fails open to detection", () => {
    setUserCapsSource({
      getOverride: () => { throw new Error("kv down"); },
    });
    const caps = getCapabilitiesForModel("nvidia", "stepfun-ai/step-5-preview");
    expect(caps.vision).toBe(false);
    expect(caps.contextWindow).toBe(128000);
  });

  it("with no source installed, detection is unchanged", () => {
    expect(getCapabilitiesForModel("nvidia", "stepfun-ai/step-5-preview").vision).toBe(false);
    expect(getCapabilitiesForModel("glm", "glm-5.3-flash").vision).toBe(true);
  });
});
