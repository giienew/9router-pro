// Regression: an unmatched 4xx (a request-scoped failure) used to hit the
// transient-cooldown default, which locked the account for 30s and — with a
// single connection — answered every other request in that window with a copy of
// the first error. A 400 "maximum context length" from one session therefore
// looked like the same failure in unrelated sessions.
import { describe, expect, it } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

describe("checkFallbackError — request-scoped vs account-scoped failures", () => {
  it("does not cool the account down for a 400 caused by the request", () => {
    const result = checkFallbackError(400, JSON.stringify({
      error: {
        message: "This model's maximum context length is 1048576 tokens. However, you requested 1186139 tokens",
        type: "invalid_request_error",
      },
    }));

    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0, requestScoped: true });
  });

  it("still falls back for account-scoped statuses", () => {
    for (const status of [401, 402, 403, 404, 429]) {
      expect(checkFallbackError(status, "nope").shouldFallback).toBe(true);
    }
  });

  // P1-16 (A-m4): request-scoped 4xx short-circuit BEFORE generic text
  // rules. A 400 validation error whose body merely mentions "rate
  // limit" used to earn the account a backoff lock, while a plain 400
  // was correctly request-scoped. The status now dominates for 4xx
  // without their own rule; 402 keeps the payment rule for broke
  // accounts, and 429 keeps the rate-limit rule.
  it("no longer cools the account for rate-limit / quota wording on a request-scoped 4xx", () => {
    expect(checkFallbackError(400, "rate limit reached")).toEqual({
      shouldFallback: false, cooldownMs: 0, requestScoped: true,
    });
    expect(checkFallbackError(422, "quota exceeded")).toEqual({
      shouldFallback: false, cooldownMs: 0, requestScoped: true,
    });
  });

  it.each([
    "You have insufficient credits to make this request. Please purchase more credits to continue using the service.",
    "INSUFFICIENT CREDITS",
    "Insufficient credit balance",
    "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    "CREDIT BALANCE IS TOO LOW",
  ])("credit wording on a 400 is request-scoped now (402 keeps the payment rule): %s", (message) => {
    expect(checkFallbackError(400, message)).toEqual({
      shouldFallback: false, cooldownMs: 0, requestScoped: true,
    });
  });

  it("still falls back with backoff for a 402 credit error", () => {
    // The credit text rule fires before the 402 status rule, as before.
    expect(checkFallbackError(402, "insufficient credits")).toEqual({
      shouldFallback: true, cooldownMs: 2000, newBackoffLevel: 1,
    });
  });

  it("provider-specific text rules still win over the short-circuit", () => {
    expect(checkFallbackError(400, "request illegal", 0, "codebuddy-intl")).toEqual({
      shouldFallback: true, cooldownMs: 2000, newBackoffLevel: 1,
    });
    // Same wording from another provider is not a provider rule.
    expect(checkFallbackError(400, "request illegal", 0, "dahl")).toEqual({
      shouldFallback: false, cooldownMs: 0, requestScoped: true,
    });
  });

  it("status-rule 4xx keep their rules even with rate-limit wording", () => {
    expect(checkFallbackError(404, "rate limit reached").shouldFallback).toBe(true);
    expect(checkFallbackError(429, "whatever").shouldFallback).toBe(true);
  });

  it("does not fall back for an ordinary bad request", () => {
    expect(checkFallbackError(400, "Bad request")).toEqual({
      shouldFallback: false, cooldownMs: 0, requestScoped: true,
    });
  });

  it("keeps the transient cooldown for unmatched server errors", () => {
    const result = checkFallbackError(503, "upstream exploded");

    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBeGreaterThan(0);
  });
});
