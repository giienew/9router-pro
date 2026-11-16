import { describe, it, expect, vi } from "vitest";
import {
  createVariantHelpers,
  stripPanelTools,
  applyCapacityStrategy,
  dispatchCombo,
} from "../../src/sse/services/comboDispatch.js";
import { accountExhaustedResponse } from "../../src/sse/services/memberFailover.js";

// dispatchCombo's real handleComboChat/handleFusionChat do streaming work;
// capture the handleSingleModel they receive and invoke it directly, so
// the threading contract is tested without a live upstream.
const comboMocks = vi.hoisted(() => ({ captured: { combo: null, fusion: null } }));

vi.mock("../../open-sse/services/combo.js", () => ({
  handleComboChat: async (opts) => {
    comboMocks.captured.combo = opts;
    return "combo-result";
  },
  handleFusionChat: async (opts) => {
    comboMocks.captured.fusion = opts;
    return "fusion-result";
  },
}));

const PROMPT = {
  name: "mycombo",
  entry: { mode: "single", content: "steer", turns: [], position: "append", enabled: true },
};
const quietLog = { info: () => {}, warn: () => {}, debug: () => {} };

async function runDispatch({ strategy = "fallback", comboPrompt = PROMPT, comboName = "mycombo" } = {}) {
  const seen = [];
  const handleSingleModel = async (...args) => {
    seen.push(args);
    return new Response("ok");
  };
  const result = await dispatchCombo({
    body: { messages: [{ role: "user", content: "hi" }] },
    comboName,
    comboModels: ["dahl/a", "dahl/b"],
    settings: { comboStrategies: { [comboName]: { fallbackStrategy: strategy } } },
    apiKey: null,
    keyAccess: null,
    requiredCapabilities: new Set(),
    variants: {},
    clientRawRequest: null,
    request: null,
    log: quietLog,
    sessionId: null,
    handleSingleModel,
    getCapacityConnections: async () => ({}),
    recordBreakerSuccess: true,
    comboPrompt,
  });
  return { result, seen };
}

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

describe("dispatchCombo threads the combo prompt (issue #2)", () => {
  it("fallback path: every member attempt receives the combo prompt as the 11th arg", async () => {
    const { result, seen } = await runDispatch({});
    expect(result).toBe("combo-result");
    await comboMocks.captured.combo.handleSingleModel({ messages: [] }, "dahl/a", null);
    expect(seen).toHaveLength(1);
    expect(seen[0][1]).toBe("dahl/a");
    expect(seen[0][6]).toBe("mycombo");
    expect(seen[0][10]).toBe(PROMPT);
  });

  it("fusion panel path: panel members receive the combo prompt too", async () => {
    const { result, seen } = await runDispatch({ strategy: "fusion" });
    expect(result).toBe("fusion-result");
    await comboMocks.captured.fusion.handleSingleModel({ messages: [] }, "dahl/b", true, null);
    expect(seen).toHaveLength(1);
    expect(seen[0][1]).toBe("dahl/b");
    expect(seen[0][10]).toBe(PROMPT);
  });

  it("no combo prompt: members receive null (stack unchanged)", async () => {
    const { seen } = await runDispatch({ comboPrompt: null });
    await comboMocks.captured.combo.handleSingleModel({ messages: [] }, "dahl/a", null);
    expect(seen).toHaveLength(1);
    expect(seen[0][10]).toBeNull();
  });

  it("nested combo: the inner dispatch delivers the INNER prompt, not the outer's", async () => {
    // chat.js resolves the inner combo's prompt at the nested branch and
    // passes it to its own dispatchCombo call; the outer prompt must not
    // leak into inner members. Each dispatch carries exactly its own.
    const OUTER = { name: "outer", entry: { mode: "single", content: "outer-steer", turns: [], position: "append", enabled: true } };
    const INNER = { name: "inner", entry: { mode: "single", content: "inner-steer", turns: [], position: "append", enabled: true } };
    const outerRun = await runDispatch({ comboName: "outer", comboPrompt: OUTER });
    await comboMocks.captured.combo.handleSingleModel({ messages: [] }, "dahl/a", null);
    expect(outerRun.seen[0][10]).toBe(OUTER);

    const innerRun = await runDispatch({ comboName: "inner", comboPrompt: INNER });
    await comboMocks.captured.combo.handleSingleModel({ messages: [] }, "dahl/b", null);
    expect(innerRun.seen[0][10]).toBe(INNER);
    expect(innerRun.seen[0][10].entry.content).toBe("inner-steer");
  });
});
