// Capacity strategy ordering (P3-28): healthy fleets first, stable otherwise.
// Run from tests/:
//   bun x vitest run unit/capacity-order.test.js
import { describe, it, expect } from "vitest";
import { orderModelsByCapacity } from "@/sse/services/capacityOrder.js";

const conn = (provider, extra = {}) => ({ id: `${provider}-${Math.random()}`, provider, isActive: true, ...extra });
const locked = (provider, model) => conn(provider, { [`modelLock_${model}`]: new Date(Date.now() + 60000).toISOString() });
const suspect = (provider) => conn(provider, { backoffLevel: 1, lastError: "x", lastErrorAt: new Date().toISOString() });

describe("orderModelsByCapacity", () => {
  it("prefers the provider with more clean connections", () => {
    const models = ["dahl/deepseek-ai/DeepSeek-V4-Flash-0731", "openai/gpt-5.4"];
    const connections = [conn("dahl"), conn("openai"), conn("openai"), conn("openai")];
    expect(orderModelsByCapacity(models, connections)[0]).toBe("openai/gpt-5.4");
  });
  it("counts only unlocked connections, and clean beats suspect", () => {
    const models = ["dahl/deepseek-ai/DeepSeek-V4-Flash-0731", "openai/gpt-5.4"];
    const connections = [
      locked("dahl", "deepseek-ai/DeepSeek-V4-Flash-0731"),
      locked("dahl", "deepseek-ai/DeepSeek-V4-Flash-0731"),
      suspect("openai"),
    ];
    // dahl: 0 available; openai: 1 suspect available (score 1) — openai wins.
    expect(orderModelsByCapacity(models, connections)[0]).toBe("openai/gpt-5.4");
  });
  it("is stable for members with no connections", () => {
    const models = ["dahl/a", "openai/b", "anthropic/c"];
    expect(orderModelsByCapacity(models, [])).toEqual(models);
  });
  it("resolves variant members through their backing model", () => {
    const models = ["my-variant", "openai/gpt-5.4"];
    const connections = [conn("openai"), conn("openai")];
    const out = orderModelsByCapacity(models, connections, {
      resolveBacking: (m) => (m === "my-variant" ? "dahl/deepseek-ai/DeepSeek-V4-Flash-0731" : null),
    });
    // Variant's backing provider (dahl) has no connections; openai has 2.
    expect(out[0]).toBe("openai/gpt-5.4");
  });
  it("returns short lists untouched", () => {
    expect(orderModelsByCapacity([], [])).toEqual([]);
    expect(orderModelsByCapacity(["dahl/a"], [conn("dahl")])).toEqual(["dahl/a"]);
  });
});
