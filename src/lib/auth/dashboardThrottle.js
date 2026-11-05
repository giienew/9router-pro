// Light per-session throttle for expensive dashboard test/mutate endpoints
// (provider test-batch, model test, bulk imports, bulk deletes). In-memory
// and per process, like loginLimiter / keyRateLimiter: state resets on
// restart, which is fine for a dashboard abuse guard. Never throws — any
// internal error admits the request. Keyed by client IP (trusted-peer aware
// via getClientIp) + route, so one dashboard session cannot starve the rest.
import { NextResponse } from "next/server";
import { getClientIp } from "./loginLimiter.js";

const WINDOW_MS = Number(process.env.DASHBOARD_THROTTLE_WINDOW_MS || 60 * 1000) || 60 * 1000;
export const DASHBOARD_THROTTLE_MAX_TEST = Number(process.env.DASHBOARD_THROTTLE_MAX_TEST || 10) || 10;
export const DASHBOARD_THROTTLE_MAX_MUTATE = Number(process.env.DASHBOARD_THROTTLE_MAX_MUTATE || 5) || 5;
const MAX_BUCKETS = 5000; // pathological-memory guard

const buckets = new Map(); // `${ip}:${routeKey}` -> { count, windowStart }

export function checkDashboardThrottle(request, routeKey, max) {
  try {
    const ip = getClientIp(request);
    const key = `${ip}:${routeKey}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
      bucket = { count: 0, windowStart: now };
      buckets.set(key, bucket);
      if (buckets.size > MAX_BUCKETS) buckets.delete(buckets.keys().next().value); // oldest
    }
    bucket.count += 1;
    if (bucket.count > max) {
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000)),
      };
    }
    return { allowed: true };
  } catch {
    return { allowed: true };
  }
}

export function dashboardThrottleResponse(retryAfterSec) {
  return NextResponse.json(
    { error: { code: "rate_limited", message: "Too many requests. Please wait a moment and try again." } },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
  );
}

export function __resetDashboardThrottle() {
  buckets.clear();
}
