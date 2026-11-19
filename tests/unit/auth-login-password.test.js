import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";

// Env must be set BEFORE the route (and the real dashboardSession it
// imports) loads: the JWT secret is read once at module load.
process.env.JWT_SECRET = "test-jwt-secret-for-login-route-tests-only";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "9r-login-test-"));

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  cookieSet: vi.fn(),
  cookieStore: null,
  store: { data: {} },
  isLocalRequest: vi.fn(() => true),
  checkLock: vi.fn(() => ({ locked: false })),
  recordFail: vi.fn(() => ({ remainingBeforeLock: 4 })),
  recordSuccess: vi.fn(),
  getClientIp: vi.fn(() => "127.0.0.1"),
  isTotpEnabled: vi.fn(async () => false),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: mocks.json },
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => mocks.cookieStore),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ ...mocks.store.data })),
  updateSettings: vi.fn(async (updates) => {
    mocks.store.data = { ...mocks.store.data, ...updates };
    return { ...mocks.store.data };
  }),
}));

vi.mock("@/lib/auth/oidc", () => ({ isOidcConfigured: vi.fn(() => false) }));
vi.mock("@/lib/auth/saml.js", () => ({ isSamlConfigured: vi.fn(() => false) }));
vi.mock("@/lib/auth/loginLimiter", () => ({
  checkLock: mocks.checkLock,
  recordFail: mocks.recordFail,
  recordSuccess: mocks.recordSuccess,
  getClientIp: mocks.getClientIp,
}));
vi.mock("@/lib/auth/totp.js", () => ({
  isTotpEnabled: mocks.isTotpEnabled,
  verifyTotp: vi.fn(() => true),
  consumeBackupCode: vi.fn(async () => true),
  getTotpConfig: vi.fn(async () => ({ secret: "x" })),
}));
vi.mock("@/dashboardGuard", () => ({ isLocalRequest: mocks.isLocalRequest }));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: vi.fn(async () => ({})) }));
vi.mock("@/lib/trustEvents.js", () => ({ recordSecurityEvent: vi.fn() }));

const { POST } = await import("../../src/app/api/auth/login/route.js");
const dashboardSession = await import("../../src/lib/auth/dashboardSession.js");

function makeRequest(password, { remote = false } = {}) {
  mocks.isLocalRequest.mockReturnValue(!remote);
  return {
    json: async () => ({ password }),
    headers: {
      get: (name) => {
        if (name === "host") return "localhost:3000";
        return null;
      },
    },
  };
}

function issuedToken() {
  const call = mocks.cookieSet.mock.calls.find(([name]) => name === "auth_token");
  return call ? call[1] : null;
}

describe("POST /api/auth/login — bcrypt-only verification (real route + real session module)", () => {
  beforeEach(() => {
    mocks.store.data = {};
    delete process.env.INITIAL_PASSWORD;
    vi.clearAllMocks();
    mocks.cookieStore = { set: mocks.cookieSet, get: vi.fn(() => undefined), delete: vi.fn() };
    mocks.checkLock.mockReturnValue({ locked: false });
    mocks.recordFail.mockReturnValue({ remainingBeforeLock: 4 });
    mocks.isLocalRequest.mockReturnValue(true);
    mocks.isTotpEnabled.mockResolvedValue(false);
  });

  it("logs in with a bcrypt-hashed stored password and issues a verifiable token", async () => {
    mocks.store.data.password = await bcrypt.hash("admin-pass-123", 10);
    const res = await POST(makeRequest("admin-pass-123"));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const token = issuedToken();
    expect(token).toBeTruthy();
    expect(await dashboardSession.verifyDashboardAuthToken(token)).toBe(true);
  });

  it("also logs in remotely with a bcrypt-hashed stored password", async () => {
    mocks.store.data.password = await bcrypt.hash("admin-pass-123", 10);
    const res = await POST(makeRequest("admin-pass-123", { remote: true }));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("rejects a wrong password with 401 and issues no token", async () => {
    mocks.store.data.password = await bcrypt.hash("admin-pass-123", 10);
    const res = await POST(makeRequest("not-the-password"));
    expect(res.status).toBe(401);
    expect(issuedToken()).toBeNull();
  });

  it("migrates a legacy plaintext stored password on login and keeps it working", async () => {
    mocks.store.data.password = "legacy-plaintext-pass";
    const first = await POST(makeRequest("legacy-plaintext-pass"));
    expect(first.status).toBe(200);
    // Stored value is now a bcrypt hash of the same password, not plaintext.
    expect(mocks.store.data.password).not.toBe("legacy-plaintext-pass");
    expect(dashboardSession.isBcryptHash(mocks.store.data.password)).toBe(true);
    // A second login with the same password still works (no lockout).
    vi.clearAllMocks();
    mocks.cookieStore = { set: mocks.cookieSet, get: vi.fn(() => undefined), delete: vi.fn() };
    const second = await POST(makeRequest("legacy-plaintext-pass"));
    expect(second.status).toBe(200);
    expect(await dashboardSession.verifyDashboardAuthToken(issuedToken())).toBe(true);
  });

  it("hashes INITIAL_PASSWORD on first login and keeps working after the env is removed", async () => {
    process.env.INITIAL_PASSWORD = "env-initial-pass-9";
    const first = await POST(makeRequest("env-initial-pass-9"));
    expect(first.status).toBe(200);
    expect(mocks.store.data.password).not.toBe("env-initial-pass-9");
    expect(dashboardSession.isBcryptHash(mocks.store.data.password)).toBe(true);

    delete process.env.INITIAL_PASSWORD;
    vi.clearAllMocks();
    mocks.cookieStore = { set: mocks.cookieSet, get: vi.fn(() => undefined), delete: vi.fn() };
    const second = await POST(makeRequest("env-initial-pass-9"));
    expect(second.status).toBe(200);
  });

  it("fails closed (401) when no password is configured and no env value is set", async () => {
    const res = await POST(makeRequest("anything-at-all"));
    expect(res.status).toBe(401);
    expect(issuedToken()).toBeNull();
  });
});
