// Audit item 6e (pro.29, integration): the main dashboard session cookie
// must be Secure by default (unless AUTH_COOKIE_SECURE=false).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({})),
  updateSettings: vi.fn(async () => ({})),
}));

import { shouldUseSecureCookie } from "../../src/lib/auth/dashboardSession.js";

const ORIGINAL_ENV = process.env.AUTH_COOKIE_SECURE;

describe("shouldUseSecureCookie — Secure default-on", () => {
  beforeEach(() => {
    delete process.env.AUTH_COOKIE_SECURE;
  });
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.AUTH_COOKIE_SECURE;
    else process.env.AUTH_COOKIE_SECURE = ORIGINAL_ENV;
  });

  it("is Secure by default (no env, plain-HTTP request)", () => {
    expect(shouldUseSecureCookie({ headers: { get: () => "http" } })).toBe(true);
  });

  it("is Secure by default with no request at all", () => {
    expect(shouldUseSecureCookie()).toBe(true);
  });

  it("opts out only on explicit AUTH_COOKIE_SECURE=false", () => {
    process.env.AUTH_COOKIE_SECURE = "false";
    expect(shouldUseSecureCookie({ headers: { get: () => "https" } })).toBe(false);
  });

  it("stays Secure on explicit AUTH_COOKIE_SECURE=true", () => {
    process.env.AUTH_COOKIE_SECURE = "true";
    expect(shouldUseSecureCookie()).toBe(true);
  });
});
