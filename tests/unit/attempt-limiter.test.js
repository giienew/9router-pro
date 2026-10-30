// Shared account-attempt limiter for the modality fallback loops: same cap
// semantics as chat's combo member cap, so a campaign-wide failure stops
// after `cap` failed accounts instead of grinding the whole pool.
// Run from tests/:
//   bun x vitest run unit/attempt-limiter.test.js
import assert from "node:assert";
import {
  resolveComboMemberAttemptCap,
  createAttemptLimiter,
} from "../../src/sse/services/memberFailover.js";

describe("resolveComboMemberAttemptCap", () => {
  it("defaults to 3, clamps to 1..10, and maps 0 to null (disabled)", () => {
    assert.equal(resolveComboMemberAttemptCap({}), 3);
    assert.equal(resolveComboMemberAttemptCap(undefined), 3);
    assert.equal(resolveComboMemberAttemptCap({ comboMemberAttemptCap: 0 }), null);
    assert.equal(resolveComboMemberAttemptCap({ comboMemberAttemptCap: 99 }), 10);
    assert.equal(resolveComboMemberAttemptCap({ comboMemberAttemptCap: -5 }), 1);
    assert.equal(resolveComboMemberAttemptCap({ comboMemberAttemptCap: "5" }), 5);
    assert.equal(resolveComboMemberAttemptCap({ comboMemberAttemptCap: "" }), 3);
  });
});

describe("createAttemptLimiter", () => {
  it("exceeds exactly at the cap", () => {
    const limiter = createAttemptLimiter(3);
    limiter.recordFailure();
    assert.equal(limiter.exceeded, false);
    limiter.recordFailure();
    assert.equal(limiter.exceeded, false);
    limiter.recordFailure();
    assert.equal(limiter.exceeded, true);
    assert.equal(limiter.failures, 3);
  });

  it("never exceeds when the cap is null (disabled)", () => {
    const limiter = createAttemptLimiter(null);
    for (let i = 0; i < 100; i++) limiter.recordFailure();
    assert.equal(limiter.exceeded, false);
    assert.equal(limiter.failures, 100);
  });

  it("a cap of 1 stops after the first failure", () => {
    const limiter = createAttemptLimiter(1);
    limiter.recordFailure();
    assert.equal(limiter.exceeded, true);
  });
});
