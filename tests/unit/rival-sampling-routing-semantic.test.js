// R7 sampling params, R9 latency/exploration, R13 semantic similarity.
import { describe, expect, it } from "vitest";
import { cleanSamplingParams, applyVariantSampling } from "../../src/lib/db/repos/promptInjectRepo.js";
import { applyExploration, buildAutoCandidates } from "../../src/sse/services/autoRouting.js";
import {
  tokenize, promptSimilarity, isSemanticCacheable, findSimilarEntry, scopeForKey, extractPromptText,
} from "../../src/lib/semanticCache.js";

describe("R7 cleanSamplingParams", () => {
  it("keeps in-range values and drops out-of-range ones", () => {
    expect(cleanSamplingParams({ temperature: 0.7, top_p: 0.9, max_tokens: 512 })).toEqual({ temperature: 0.7, top_p: 0.9, max_tokens: 512 });
    expect(cleanSamplingParams({ temperature: 5, top_p: 0, max_tokens: -1 })).toBeNull();
    expect(cleanSamplingParams({ temperature: 0 })).toEqual({ temperature: 0 });
    expect(cleanSamplingParams(null)).toBeNull();
  });
  it("applyVariantSampling overrides client defaults, variant only", () => {
    const body = { model: "v", temperature: 1, top_p: 1, max_tokens: 100 };
    const out = applyVariantSampling(body, { temperature: 0 });
    expect(out.temperature).toBe(0);
    expect(out.top_p).toBe(1); // untouched field stays a client default
    expect(body.temperature).toBe(1); // input untouched
    expect(applyVariantSampling(body, null)).toBe(body);
  });
});

describe("R9 exploration", () => {
  it("is deterministic per seed and a no-op at share 0", () => {
    const ranked = ["a", "b", "c", "d"];
    expect(applyExploration(ranked, { share: 0, seed: "x" })).toEqual(ranked);
    const once = applyExploration(ranked, { share: 1, seed: "day-1" });
    expect(applyExploration(ranked, { share: 1, seed: "day-1" })).toEqual(once);
    expect(once[0]).not.toBe("a"); // share 1 always promotes a lower candidate
    expect([...once].sort()).toEqual([...ranked].sort()); // same set, new order
  });
  it("measured latency changes the fast ranking (and nothing else by default)", () => {
    const conns = [
      { id: "d-1", provider: "dahl", isActive: true },
      { id: "o-1", provider: "openai", isActive: true },
    ];
    const noLat = buildAutoCandidates({ intent: "fast", connections: conns });
    const withLat = buildAutoCandidates({ intent: "fast", connections: conns, latencyByProvider: { dahl: 50, openai: 5000 } });
    expect(noLat.length).toBeGreaterThan(0);
    expect(withLat.length).toBeGreaterThan(0);
    // With a huge latency gap the fast list must favour the fast provider's models.
    expect(withLat[0].startsWith("dahl/")).toBe(true);
  });
});

describe("R13 semantic cache", () => {
  it("scores near-identical prompts high, different prompts low", () => {
    expect(promptSimilarity("What is the status of my order?", "What is the status of my order please?")).toBeGreaterThanOrEqual(0.8);
    expect(promptSimilarity("What is the status of my order?", "Write a poem about cats")).toBeLessThan(0.3);
    expect(tokenize("The cat sat").has("the")).toBe(false); // stopwords removed
  });
  it("only accepts non-streaming, tool-free chat bodies", () => {
    const base = { model: "m", messages: [{ role: "user", content: "hi there" }] };
    expect(isSemanticCacheable(base)).toBe(true);
    expect(isSemanticCacheable({ ...base, stream: true })).toBe(false);
    expect(isSemanticCacheable({ ...base, tools: [] })).toBe(false);
    expect(extractPromptText(base)).toBe("hi there");
  });
  it("scopes per key: different keys never share", () => {
    expect(scopeForKey("sk-a")).not.toBe(scopeForKey("sk-b"));
    expect(scopeForKey("sk-a")).toBe(scopeForKey("sk-a"));
  });
  it("finds the best similar entry above threshold", () => {
    const entries = [
      { prompt: "status of my order", response: { a: 1 } },
      { prompt: "poem about cats", response: { a: 2 } },
    ];
    const hit = findSimilarEntry(entries, "status of my order please", 0.8);
    expect(hit.response).toEqual({ a: 1 });
    expect(findSimilarEntry(entries, "quantum physics lecture", 0.8)).toBeNull();
  });
});
