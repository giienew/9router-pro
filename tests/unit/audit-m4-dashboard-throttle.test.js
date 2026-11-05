// Guards the M-4 dashboard throttle: a session gets its budgeted calls
// per window, the next one is refused with a retry-after, and buckets are
// isolated per IP + route.
import { describe, it, expect, beforeEach } from "vitest";
import {
  checkDashboardThrottle,
  dashboardThrottleResponse,
  __resetDashboardThrottle,
} from "../../src/lib/auth/dashboardThrottle.js";

function fakeRequest(ip) {
  return { headers: new Headers({ "cf-connecting-ip": ip }) };
}

describe("checkDashboardThrottle", () => {
  beforeEach(() => __resetDashboardThrottle());

  it("allows up to max calls, then refuses with a retry-after", () => {
    const req = fakeRequest("203.0.113.7");
    for (let i = 0; i < 5; i++) {
      expect(checkDashboardThrottle(req, "proxy-pools/delete-failed", 5)).toEqual({ allowed: true });
    }
    const blocked = checkDashboardThrottle(req, "proxy-pools/delete-failed", 5);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("isolates buckets per route and per IP", () => {
    const reqA = fakeRequest("203.0.113.7");
    const reqB = fakeRequest("198.51.100.9");
    checkDashboardThrottle(reqA, "models/test", 1);
    expect(checkDashboardThrottle(reqA, "models/test", 1).allowed).toBe(false);
    expect(checkDashboardThrottle(reqA, "providers/test-batch", 1).allowed).toBe(true);
    expect(checkDashboardThrottle(reqB, "models/test", 1).allowed).toBe(true);
  });

  it("never throws on a malformed request", () => {
    expect(checkDashboardThrottle(null, "models/test", 1)).toEqual({ allowed: true });
    expect(checkDashboardThrottle({}, "models/test", 1)).toEqual({ allowed: true });
  });
});

describe("dashboardThrottleResponse", () => {
  it("returns 429 with the canonical rate_limited body and Retry-After", async () => {
    const res = dashboardThrottleResponse(42);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(await res.json()).toEqual({
      error: { code: "rate_limited", message: "Too many requests. Please wait a moment and try again." },
    });
  });
});
