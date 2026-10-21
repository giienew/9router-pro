// 9Router Pro — Key Limits tests: config cleaning + the in-memory rate
// limiter (RPM/RPH/RPD windows, concurrency slots). Pure logic, explicit
// clocks. Run: npx vitest run pro/key-limits.test.js
import assert from "node:assert";
import { cleanKeyLimits } from "@/lib/db/repos/keyLimitRepo.js";
import { peekKeyLimits, admitKeyRequest, getKeyLimitUsage, __resetKeyRateLimiter } from "@/lib/keyRateLimiter.js";

const T0 = 1_700_000_000_000;
const MIN = 60 * 1000;

describe("cleanKeyLimits", () => {
  it("null / junk / empty → null (no limits configured)", () => {
    assert.equal(cleanKeyLimits(null), null);
    assert.equal(cleanKeyLimits("nope"), null);
    assert.equal(cleanKeyLimits({}), null);
    assert.equal(cleanKeyLimits({ rpm: 0, tpm: -5, rpd: "abc" }), null);
  });

  it("keeps set fields, nulls the rest, floors and accepts numeric strings", () => {
    assert.deepEqual(cleanKeyLimits({ rpm: 60 }), { rpm: 60, tpm: null, rph: null, rpd: null, maxConcurrent: null });
    assert.equal(cleanKeyLimits({ rpm: 12.9 }).rpm, 12);
    assert.equal(cleanKeyLimits({ rpd: "5000" }).rpd, 5000);
  });

  it("caps absurd values", () => {
    assert.equal(cleanKeyLimits({ rpm: 99999999 }).rpm, 1000000);
    assert.equal(cleanKeyLimits({ maxConcurrent: 99999 }).maxConcurrent, 10000);
  });
});

describe("keyRateLimiter — request windows", () => {
  it("no config or no traffic → never blocked", () => {
    __resetKeyRateLimiter();
    assert.equal(peekKeyLimits("k1", null, T0).blocked, false);
    assert.equal(peekKeyLimits("k1", { rpm: 5 }, T0).blocked, false);
  });

  it("rpm blocks at the limit with a sane Retry-After, then the window slides open", () => {
    __resetKeyRateLimiter();
    const limits = { rpm: 2, tpm: null, rph: null, rpd: null, maxConcurrent: null };
    admitKeyRequest("k1", T0)();
    admitKeyRequest("k1", T0 + 1000)();
    const v = peekKeyLimits("k1", limits, T0 + 2000);
    assert.equal(v.blocked, true);
    assert.equal(v.kind, "rpm");
    assert.equal(v.used, 2);
    assert.ok(v.retryAfterSec >= 1 && v.retryAfterSec <= 60, `retryAfter ${v.retryAfterSec}`);
    assert.equal(peekKeyLimits("k1", limits, T0 + MIN + 1).blocked, false);
  });

  it("rpd counts across minutes (independent of the rpm window)", () => {
    __resetKeyRateLimiter();
    const limits = { rpm: null, tpm: null, rph: null, rpd: 3, maxConcurrent: null };
    admitKeyRequest("k1", T0)();
    admitKeyRequest("k1", T0 + 5 * MIN)();
    admitKeyRequest("k1", T0 + 10 * MIN)();
    const v = peekKeyLimits("k1", limits, T0 + 11 * MIN);
    assert.equal(v.blocked, true);
    assert.equal(v.kind, "rpd");
    assert.equal(peekKeyLimits("k1", limits, T0 + 24 * 3600 * 1000 + 1).blocked, false);
  });
});

describe("keyRateLimiter — concurrency slots", () => {
  it("blocks while a slot is held, frees on release, double release is safe", () => {
    __resetKeyRateLimiter();
    const limits = { rpm: null, tpm: null, rph: null, rpd: null, maxConcurrent: 1 };
    const release = admitKeyRequest("k1", T0);
    const v = peekKeyLimits("k1", limits, T0);
    assert.equal(v.blocked, true);
    assert.equal(v.kind, "concurrency");
    release();
    release();
    assert.equal(peekKeyLimits("k1", limits, T0).blocked, false);
    assert.equal(getKeyLimitUsage("k1", T0).inFlight, 0);
  });

  it("usage snapshot reports window counts and in-flight", () => {
    __resetKeyRateLimiter();
    const r1 = admitKeyRequest("k1", T0);
    admitKeyRequest("k1", T0 + 500)();
    const u = getKeyLimitUsage("k1", T0 + 1000);
    assert.equal(u.rpmUsed, 2);
    assert.equal(u.rpdUsed, 2);
    assert.equal(u.inFlight, 1);
    r1();
    assert.equal(getKeyLimitUsage("k1", T0 + 1000).inFlight, 0);
  });
});
