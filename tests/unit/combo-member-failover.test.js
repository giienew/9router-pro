// Smart member failover cap: one combo member must not grind its whole
// account pool while the client waits — after a few failed accounts the
// member gives up so the combo moves to its next member at once.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMBO_MEMBER_ATTEMPT_CAP,
  resolveComboMemberAttemptCap,
} from "../../src/sse/services/memberFailover.js";

describe("resolveComboMemberAttemptCap", () => {
  it("defaults to 3 when the setting is absent", () => {
    expect(resolveComboMemberAttemptCap({})).toBe(3);
    expect(resolveComboMemberAttemptCap(null)).toBe(3);
    expect(resolveComboMemberAttemptCap(undefined)).toBe(3);
    expect(DEFAULT_COMBO_MEMBER_ATTEMPT_CAP).toBe(3);
  });

  it("honours an explicit setting", () => {
    expect(resolveComboMemberAttemptCap({ comboMemberAttemptCap: 1 })).toBe(1);
    expect(resolveComboMemberAttemptCap({ comboMemberAttemptCap: 5 })).toBe(5);
    expect(resolveComboMemberAttemptCap({ comboMemberAttemptCap: "2" })).toBe(2);
  });

  it("clamps to 1..10", () => {
    expect(resolveComboMemberAttemptCap({ comboMemberAttemptCap: 0 + 0.4 })).toBe(1);
    expect(resolveComboMemberAttemptCap({ comboMemberAttemptCap: -4 })).toBe(1);
    expect(resolveComboMemberAttemptCap({ comboMemberAttemptCap: 99 })).toBe(10);
    expect(resolveComboMemberAttemptCap({ comboMemberAttemptCap: 4.9 })).toBe(4);
  });

  it("treats an explicit 0 as no cap", () => {
    expect(resolveComboMemberAttemptCap({ comboMemberAttemptCap: 0 })).toBeNull();
  });

  it("falls back to the default for garbage values", () => {
    expect(resolveComboMemberAttemptCap({ comboMemberAttemptCap: "abc" })).toBe(3);
    expect(resolveComboMemberAttemptCap({ comboMemberAttemptCap: "" })).toBe(3);
    expect(resolveComboMemberAttemptCap({ comboMemberAttemptCap: NaN })).toBe(3);
  });
});
