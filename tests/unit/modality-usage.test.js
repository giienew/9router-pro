// G9: modality usage accrual — helper shape + repo cost/meta passthrough.
// Handler-level accrual is verified by build + the per-handler code paths
// (all fire-and-forget saveRequestUsage calls); these unit tests pin the
// shared pieces that would otherwise silently lose spend.
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestUsage: vi.fn().mockResolvedValue({ inserted: true }),
}));

import { saveRequestUsage } from "@/lib/usageDb.js";
import { recordModalityUsage, estimateTokensFromText } from "../../src/sse/services/modalityUsage.js";

describe("estimateTokensFromText", () => {
  it("uses chars/4, rounding up", () => {
    expect(estimateTokensFromText("")).toBe(0);
    expect(estimateTokensFromText("abcd")).toBe(1);
    expect(estimateTokensFromText("abcde")).toBe(2);
  });
});

describe("recordModalityUsage", () => {
  it("passes tokens, requestId, costOverride and meta through", async () => {
    recordModalityUsage({
      provider: "tavily", model: "search", connectionId: 7, apiKey: "sk-x",
      endpoint: "/v1/search", requestId: "req_abc", costOverride: 0.01,
      meta: { accrual: "cost-only" },
    });
    await vi.waitFor(() => expect(saveRequestUsage).toHaveBeenCalled());
    const arg = saveRequestUsage.mock.calls[0][0];
    expect(arg).toMatchObject({
      provider: "tavily", model: "search", connectionId: 7, requestId: "req_abc",
      costOverride: 0.01, status: "success",
    });
    expect(arg.meta).toEqual({ accrual: "cost-only" });
  });

  it("defaults to a zero-token success row when only meta is given", async () => {
    saveRequestUsage.mockClear();
    recordModalityUsage({
      provider: "xai", model: "video", apiKey: "sk-x", endpoint: "/v1/videos",
      meta: { accrual: "request-only" },
    });
    await vi.waitFor(() => expect(saveRequestUsage).toHaveBeenCalled());
    expect(saveRequestUsage.mock.calls[0][0].tokens).toEqual({ prompt_tokens: 0, completion_tokens: 0 });
  });
});
