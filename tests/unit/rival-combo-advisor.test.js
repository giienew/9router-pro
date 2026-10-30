// R1/R4 advisor ranking: dedupe, free stack + holding, tiered draft, dry-run.
import { describe, expect, it } from "vitest";
import {
  isChatModelId, dedupeCandidates, buildFreeStack, buildTieredDraft, dryRunPreview,
} from "../../src/lib/comboAdvisor.js";

const C = (id, over = {}) => ({ id, provider: id.split("/")[0], free: false, healthy: true, rateLimited: false, latencyMs: 100, contextWindow: 32000, tools: false, reasoning: false, ...over });

describe("isChatModelId", () => {
  it("rejects image/tts/embed ids, accepts chat ids", () => {
    expect(isChatModelId("oc/mimo-v2.6-flash-free")).toBe(true);
    expect(isChatModelId("x/flux-image")).toBe(false);
    expect(isChatModelId("x/tts-model")).toBe(false);
    expect(isChatModelId("bare")).toBe(false);
  });
});

describe("dedupeCandidates", () => {
  it("keeps the healthy, lower-latency account for the same model", () => {
    const out = dedupeCandidates([
      C("a/model-x", { healthy: false, latencyMs: 10 }),
      C("b/model-x", { healthy: true, latencyMs: 500 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].provider).toBe("b");
  });
});

describe("buildFreeStack", () => {
  it("ranks free+healthy first and parks rate-limited models in holding", () => {
    const stack = buildFreeStack([
      C("a/paid", { free: false }),
      C("b/free-one", { free: true, latencyMs: 50 }),
      C("c/free-two", { free: true, rateLimited: true }),
    ]);
    expect(stack.members).toEqual(["b/free-one"]);
    expect(stack.holding).toEqual(["c/free-two"]);
  });
});

describe("buildTieredDraft", () => {
  it("picks one member per tier without repeating a model", () => {
    const draft = buildTieredDraft([
      C("a/smart", { tools: true, reasoning: true, contextWindow: 200000 }),
      C("b/quick", { latencyMs: 10 }),
      C("c/cheap", { free: true, latencyMs: 900 }),
    ]);
    expect(draft.members).toHaveLength(3);
    expect(new Set(draft.members).size).toBe(3);
    expect(draft.tiers.quality).toBe("a/smart");
    expect(draft.tiers.fast).toBe("b/quick");
  });
});

describe("dryRunPreview", () => {
  it("reports would-create vs already-exists without mutating", () => {
    const draft = { members: ["a/m"], holding: [] };
    expect(dryRunPreview({ draft, existingCombos: [], proposedName: "free-stack" }).wouldCreate).toBe(true);
    expect(dryRunPreview({ draft, existingCombos: [{ name: "free-stack" }], proposedName: "free-stack" }).wouldCreate).toBe(false);
  });
});
