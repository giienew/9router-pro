// PATCH /api/models/custom (model editor save) + the override sanitizer.
//
// PATCH upserts: editing a detected (registry) model creates its override
// row. The sanitizer is the shared one (src/shared/constants/models) —
// sparse, only the fields the user set survive; null means "Auto" and the
// key is dropped; number keys accept numeric strings and reject anything
// that is not a positive integer within bound.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/models", () => ({
  getCustomModels: vi.fn(async () => []),
  addCustomModel: vi.fn(async () => true),
  deleteCustomModel: vi.fn(async () => {}),
}));

import { PATCH, POST } from "@/app/api/models/custom/route.js";
import { addCustomModel } from "@/models";
import { sanitizeModelCapsOverride } from "@/shared/constants/models.js";

function patchRequest(body) {
  return new Request("http://localhost/api/models/custom", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function postRequest(body) {
  return new Request("http://localhost/api/models/custom", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("sanitizeModelCapsOverride", () => {
  it("keeps set booleans and valid numbers, drops Auto (null) and unknown keys", () => {
    expect(sanitizeModelCapsOverride({
      vision: true, pdf: false, reasoning: null, contextWindow: "1000000",
      maxOutput: 131072, bogus: true, search: "yes",
    })).toEqual({ vision: true, pdf: false, contextWindow: 1000000, maxOutput: 131072 });
  });

  it("rejects non-positive, non-integer and absurd numbers", () => {
    expect(sanitizeModelCapsOverride({ contextWindow: 0 })).toEqual({});
    expect(sanitizeModelCapsOverride({ contextWindow: -5 })).toEqual({});
    expect(sanitizeModelCapsOverride({ contextWindow: 1.5 })).toEqual({});
    expect(sanitizeModelCapsOverride({ contextWindow: 999_000_000 })).toEqual({});
    expect(sanitizeModelCapsOverride({ maxOutput: "abc" })).toEqual({});
  });

  it("returns null for non-objects, {} for all-Auto", () => {
    expect(sanitizeModelCapsOverride(null)).toBeNull();
    expect(sanitizeModelCapsOverride("vision")).toBeNull();
    expect(sanitizeModelCapsOverride({ vision: null })).toEqual({});
  });
});

describe("PATCH /api/models/custom", () => {
  beforeEach(() => {
    vi.mocked(addCustomModel).mockClear();
  });

  it("upserts the sparse override for a detected model", async () => {
    const res = await PATCH(patchRequest({
      providerAlias: "nvidia", id: "stepfun-ai/step-5-preview", type: "llm",
      capsOverride: { vision: true, contextWindow: 1000000 },
    }));
    expect(res.status).toBe(200);
    expect(vi.mocked(addCustomModel).mock.calls[0][0]).toMatchObject({
      providerAlias: "nvidia",
      id: "stepfun-ai/step-5-preview",
      capsOverride: { vision: true, contextWindow: 1000000 },
    });
  });

  it("an all-Auto override clears the stored override (empty object)", async () => {
    const res = await PATCH(patchRequest({
      providerAlias: "nvidia", id: "stepfun-ai/step-5-preview", capsOverride: {},
    }));
    expect(res.status).toBe(200);
    expect(vi.mocked(addCustomModel).mock.calls[0][0].capsOverride).toEqual({});
  });

  it("rejects a missing id and a body with nothing to update", async () => {
    expect((await PATCH(patchRequest({ providerAlias: "nvidia" })))).toHaveProperty("status", 400);
    expect((await PATCH(patchRequest({ providerAlias: "nvidia", id: "x" })))).toHaveProperty("status", 400);
  });

  it("rejects a non-object capsOverride", async () => {
    const res = await PATCH(patchRequest({ providerAlias: "nvidia", id: "x", capsOverride: "vision" }));
    expect(res.status).toBe(400);
  });

  it("POST still accepts the editor's capsOverride alongside legacy caps", async () => {
    const res = await POST(postRequest({
      providerAlias: "nvidia", id: "some-new-model",
      caps: { vision: true, reasoning: false },
      capsOverride: { vision: true, contextWindow: 500000 },
    }));
    expect(res.status).toBe(200);
    expect(vi.mocked(addCustomModel).mock.calls[0][0]).toMatchObject({
      caps: { vision: true, reasoning: false },
      capsOverride: { vision: true, contextWindow: 500000 },
    });
  });
});
