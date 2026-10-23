// Pair rotation (9Router Pro): a custom name with its own prompt
// injection backed by several models defaults to round-robin; any
// explicit strategy (per-combo or global) wins; storage fails open.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = { modelPrompts: {}, keyModelPrompts: {}, keyRecord: null, throwStorage: false };

vi.mock("@/lib/localDb", () => ({
  getInjectModelPrompts: async () => {
    if (state.throwStorage) throw new Error("db down");
    return state.modelPrompts;
  },
  getInjectKeyModelPrompts: async () => state.keyModelPrompts,
  getApiKeyByKey: async () => state.keyRecord,
}));

import { resolveComboStrategy } from "../../src/sse/services/pairStrategy.js";

const TWO = ["dahl/deepseek-ai/DeepSeek-V4-Flash-0731", "gonka/deepseek-ai/DeepSeek-V4-Flash-0731"];

beforeEach(() => {
  state.modelPrompts = {};
  state.keyModelPrompts = {};
  state.keyRecord = null;
  state.throwStorage = false;
});

describe("resolveComboStrategy", () => {
  it("lets the combo's own strategy win over everything", async () => {
    state.modelPrompts = { dpsk_un: { enabled: true } };
    const settings = { comboStrategies: { dpsk_un: { fallbackStrategy: "smart" } }, comboStrategy: "fusion" };
    expect(await resolveComboStrategy("dpsk_un", TWO, settings, null)).toBe("smart");
  });

  it("lets the global strategy win over the pair default", async () => {
    state.modelPrompts = { dpsk_un: { enabled: true } };
    expect(await resolveComboStrategy("dpsk_un", TWO, { comboStrategy: "fusion" }, null)).toBe("fusion");
  });

  it("rotates a multi-model pair with an all-keys injection", async () => {
    state.modelPrompts = { dpsk_un: { enabled: true } };
    expect(await resolveComboStrategy("dpsk_un", TWO, {}, null)).toBe("round-robin");
  });

  it("rotates a pair whose injection is scoped to the calling key", async () => {
    state.keyRecord = { id: "key-1" };
    state.keyModelPrompts = { "key-1": { dpsk_un: { enabled: true } } };
    expect(await resolveComboStrategy("dpsk_un", TWO, {}, "sk-raw")).toBe("round-robin");
  });

  it("keeps fallback when the pair injection is disabled", async () => {
    state.modelPrompts = { dpsk_un: { enabled: false } };
    expect(await resolveComboStrategy("dpsk_un", TWO, {}, null)).toBe("fallback");
  });

  it("keeps fallback for a combo without any injection", async () => {
    expect(await resolveComboStrategy("plain_combo", TWO, {}, null)).toBe("fallback");
  });

  it("keeps fallback for a single-model pair (nothing to rotate)", async () => {
    state.modelPrompts = { solo: { enabled: true } };
    expect(await resolveComboStrategy("solo", ["dahl/only"], {}, null)).toBe("fallback");
  });

  it("fails open to fallback when storage throws", async () => {
    state.throwStorage = true;
    expect(await resolveComboStrategy("dpsk_un", TWO, {}, null)).toBe("fallback");
  });
});
