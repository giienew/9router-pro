import { describe, it, expect } from "vitest";
import { resolveComboMemberAttemptCap } from "../../src/sse/services/memberFailover.js";

describe("per-provider/per-model cap override", () => {
  it("keeps the old global behaviour with no provider and no overrides", () => {
    expect(resolveComboMemberAttemptCap({})).toBe(3);
    expect(resolveComboMemberAttemptCap({ comboMemberAttemptCap: 5 })).toBe(5);
    expect(resolveComboMemberAttemptCap({ comboMemberAttemptCap: 0 })).toBeNull();
  });
  it("prefers a per-provider override over the global cap", () => {
    const s = { comboMemberAttemptCap: 5, comboMemberAttemptCapOverrides: { dahl: 2 } };
    expect(resolveComboMemberAttemptCap(s, "dahl")).toBe(2);
    expect(resolveComboMemberAttemptCap(s, "other")).toBe(5);
  });
  it("prefers an exact per-model override over the per-provider one", () => {
    const s = {
      comboMemberAttemptCap: 5,
      comboMemberAttemptCapOverrides: { dahl: 2, "dahl/deepseek": 7 },
    };
    expect(resolveComboMemberAttemptCap(s, "dahl", "deepseek")).toBe(7);
    expect(resolveComboMemberAttemptCap(s, "dahl", "other")).toBe(2);
  });
  it("clamps overrides to 1..10 and treats 0 as disabled", () => {
    const s = { comboMemberAttemptCapOverrides: { a: 99, b: -3, c: 0, d: "4" } };
    expect(resolveComboMemberAttemptCap(s, "a")).toBe(10);
    expect(resolveComboMemberAttemptCap(s, "b")).toBe(1);
    expect(resolveComboMemberAttemptCap(s, "c")).toBeNull();
    expect(resolveComboMemberAttemptCap(s, "d")).toBe(4);
  });
  it("falls through to global on an unparseable override, never disabling silently", () => {
    const s = { comboMemberAttemptCap: 5, comboMemberAttemptCapOverrides: { dahl: "nope", other: "" } };
    expect(resolveComboMemberAttemptCap(s, "dahl")).toBe(5);
    expect(resolveComboMemberAttemptCap(s, "other")).toBe(5);
  });
  it("ignores a non-object overrides value", () => {
    expect(resolveComboMemberAttemptCap({ comboMemberAttemptCap: 4, comboMemberAttemptCapOverrides: "dahl" }, "dahl")).toBe(4);
  });
});
