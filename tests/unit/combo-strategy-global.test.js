// Global combo strategy (P1-15): an explicit global "fallback" means
// fallback everywhere, including injected pairs; "auto" (the untouched
// default) keeps the old pair-rotation rule. Per-combo strategy wins.
// Run from tests/:
//   bun x vitest run unit/combo-strategy-global.test.js
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({
  getApiKeyByKey: async () => null,
  getInjectKeyModelPrompts: async () => ({}),
  getInjectModelPrompts: async () => ({
    "pair-name": { enabled: true },
    "pair-off": { enabled: false },
  }),
}));

const { resolveComboStrategy } = await import("../../src/sse/services/pairStrategy.js");

const PAIR = ["m/a", "m/b"];

describe("resolveComboStrategy", () => {
  it("explicit global fallback pins injected pairs", async () => {
    expect(await resolveComboStrategy("pair-name", PAIR, { comboStrategy: "fallback" }, null))
      .toBe("fallback");
  });

  it("auto keeps pair rotation for injected pairs, fallback otherwise", async () => {
    expect(await resolveComboStrategy("pair-name", PAIR, { comboStrategy: "auto" }, null))
      .toBe("round-robin");
    expect(await resolveComboStrategy("pair-off", PAIR, { comboStrategy: "auto" }, null))
      .toBe("fallback");
    expect(await resolveComboStrategy("plain", PAIR, { comboStrategy: "auto" }, null))
      .toBe("fallback");
  });

  it("a missing global value behaves like auto", async () => {
    expect(await resolveComboStrategy("pair-name", PAIR, {}, null)).toBe("round-robin");
  });

  it("global round-robin wins over the pair rule", async () => {
    expect(await resolveComboStrategy("pair-name", PAIR, { comboStrategy: "round-robin" }, null))
      .toBe("round-robin");
    expect(await resolveComboStrategy("plain", PAIR, { comboStrategy: "round-robin" }, null))
      .toBe("round-robin");
  });

  it("per-combo strategy wins, and per-combo auto falls through", async () => {
    expect(await resolveComboStrategy("pair-name", PAIR, {
      comboStrategy: "round-robin",
      comboStrategies: { "pair-name": { fallbackStrategy: "fallback" } },
    }, null)).toBe("fallback");
    expect(await resolveComboStrategy("pair-name", PAIR, {
      comboStrategy: "fallback",
      comboStrategies: { "pair-name": { fallbackStrategy: "auto" } },
    }, null)).toBe("fallback");
  });
});
