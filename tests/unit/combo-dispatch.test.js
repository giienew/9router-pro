import { describe, it, expect } from "vitest";
import {
  createVariantHelpers,
  stripPanelTools,
  applyCapacityStrategy,
} from "../../src/sse/services/comboDispatch.js";
import { accountExhaustedResponse } from "../../src/sse/services/memberFailover.js";

describe("createVariantHelpers", () => {
  it("carries a variant member's bare name and judges it by its backing model", () => {
    const { memberInjectName, variantBacking } = createVariantHelpers(
      { myvar: { model: "dahl/deepseek" } },
      "mycombo",
    );
    expect(memberInjectName("myvar")).toBe("myvar");
    expect(memberInjectName("dahl/other")).toBe("mycombo");
    expect(variantBacking("myvar")).toBe("dahl/deepseek");
    expect(variantBacking("dahl/other")).toBeNull();
  });
  it("falls back to the outer requested name, not the combo name, when given one", () => {
    const { memberInjectName } = createVariantHelpers({}, "outer");
    expect(memberInjectName("dahl/x")).toBe("outer");
  });
});

describe("stripPanelTools", () => {
  it("removes tools/tool_choice and leaves the rest of the request intact", () => {
    const req = { body: { model: "m", tools: [1], tool_choice: "auto", messages: [] }, headers: {} };
    const clean = stripPanelTools(req);
    expect(clean.body.tools).toBeUndefined();
    expect(clean.body.tool_choice).toBeUndefined();
    expect(clean.body.model).toBe("m");
    expect(req.body.tools).toEqual([1]);
  });
  it("passes a null request through", () => {
    expect(stripPanelTools(null)).toBeNull();
  });
});

describe("applyCapacityStrategy", () => {
  it("passes non-capacity strategies through untouched", async () => {
    const out = await applyCapacityStrategy({
      comboStrategy: "fallback",
      models: ["a/b", "c/d"],
      getCapacityConnections: async () => { throw new Error("must not be called"); },
      variantBacking: () => null,
      log: {},
      comboName: "combo",
    });
    expect(out).toEqual({ effectiveStrategy: "fallback", orderedModels: ["a/b", "c/d"] });
  });
});

describe("accountExhaustedResponse", () => {
  it("returns unavailable for all-rate-limited with the last error", async () => {
    const res = accountExhaustedResponse({
      credentials: { allRateLimited: true, lastError: "slow", retryAfter: new Date(Date.now() + 60000).toISOString(), retryAfterHuman: "in 60s" },
      excludeSize: 2, lastError: "last", lastStatus: 429,
      scope: "dahl/m", provider: "dahl",
      noCredentialsMessage: "No credentials for provider: dahl",
    });
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("last");
  });
  it("returns 400 on the first attempt with no credentials", async () => {
    const res = accountExhaustedResponse({
      credentials: null, excludeSize: 0, lastError: null, lastStatus: null,
      scope: "dahl/m", provider: "dahl",
      noCredentialsMessage: "No credentials for provider: dahl",
    });
    expect(res.status).toBe(400);
  });
  it("returns the last error once the pool is exhausted", async () => {
    const res = accountExhaustedResponse({
      credentials: null, excludeSize: 3, lastError: "boom", lastStatus: 502,
      scope: "dahl/m", provider: "dahl",
      noCredentialsMessage: "No credentials for provider: dahl",
    });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("boom");
  });
});
