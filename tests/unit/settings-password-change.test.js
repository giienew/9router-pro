import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";

// Env must be set BEFORE the route (and the real dashboardSession it
// imports) loads: the JWT secret is read once at module load.
process.env.JWT_SECRET = "test-jwt-secret-for-settings-patch-tests-only";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "9r-settings-test-"));

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  cookieSet: vi.fn(),
  cookieStore: null,
  store: { data: {} },
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

vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));
vi.mock("open-sse/services/combo.js", () => ({ resetComboRotation: vi.fn() }));
vi.mock("@/lib/db/paths.js", () => ({ DATA_FILE: "/tmp/test-data.sqlite" }));
vi.mock("@/lib/auth/ssoTestGate.js", () => ({
  checkSsoOnlyGate: vi.fn(() => null),
  SSO_ONLY_MODES: [],
}));

const { PATCH } = await import("../../src/app/api/settings/route.js");
const dashboardSession = await import("../../src/lib/auth/dashboardSession.js");

function makeRequest(body) {
  return {
    json: async () => ({ ...body }),
    headers: { get: () => null },
  };
}

function issuedToken() {
  const call = mocks.cookieSet.mock.calls.find(([name]) => name === "auth_token");
  return call ? call[1] : null;
}

describe("PATCH /api/settings — password change revokes pre-change sessions", () => {
  beforeEach(() => {
    mocks.store.data = {};
    delete process.env.INITIAL_PASSWORD;
    vi.clearAllMocks();
    mocks.cookieStore = { set: mocks.cookieSet, get: vi.fn(() => undefined), delete: vi.fn() };
  });

  it("old token FAILS after a password change, fresh re-issued token passes", async () => {
    mocks.store.data.password = await bcrypt.hash("old-pass-123", 10);
    mocks.store.data.tokenVersion = 0;
    const oldToken = await dashboardSession.createDashboardAuthToken();
    expect(await dashboardSession.verifyDashboardAuthToken(oldToken)).toBe(true);

    const res = await PATCH(makeRequest({ currentPassword: "old-pass-123", newPassword: "new-pass-456" }));
    expect(res.status).toBe(200);
    expect(mocks.store.data.tokenVersion).toBe(1);
    expect(await bcrypt.compare("new-pass-456", mocks.store.data.password)).toBe(true);

    // Pre-change token is dead…
    expect(await dashboardSession.verifyDashboardAuthToken(oldToken)).toBe(false);
    expect(await dashboardSession.getDashboardAuthSession(oldToken)).toBeNull();
    // …while the token re-issued to the legitimate admin by the PATCH works.
    const freshToken = issuedToken();
    expect(freshToken).toBeTruthy();
    expect(await dashboardSession.verifyDashboardAuthToken(freshToken)).toBe(true);
    expect(await dashboardSession.getDashboardAuthSession(freshToken)).not.toBeNull();
  });

  it("rejects a wrong current password and changes nothing", async () => {
    mocks.store.data.password = await bcrypt.hash("old-pass-123", 10);
    mocks.store.data.tokenVersion = 0;
    const oldToken = await dashboardSession.createDashboardAuthToken();

    const res = await PATCH(makeRequest({ currentPassword: "wrong-pass", newPassword: "new-pass-456" }));
    expect(res.status).toBe(401);
    expect(await bcrypt.compare("old-pass-123", mocks.store.data.password)).toBe(true);
    expect(mocks.store.data.tokenVersion).toBe(0);
    expect(await dashboardSession.verifyDashboardAuthToken(oldToken)).toBe(true);
    expect(issuedToken()).toBeNull();
  });

  it("first-time set with no stored password needs no current password", async () => {
    const res = await PATCH(makeRequest({ newPassword: "first-pass-1" }));
    expect(res.status).toBe(200);
    expect(await bcrypt.compare("first-pass-1", mocks.store.data.password)).toBe(true);
    expect(mocks.store.data.tokenVersion).toBe(1);
    expect(await dashboardSession.verifyDashboardAuthToken(issuedToken())).toBe(true);
  });

  it("accepts INITIAL_PASSWORD as the current password on first change (bcrypt path, no plaintext list)", async () => {
    process.env.INITIAL_PASSWORD = "env-initial-pass-9";
    const res = await PATCH(
      makeRequest({ currentPassword: "env-initial-pass-9", newPassword: "changed-pass-2" })
    );
    expect(res.status).toBe(200);
    expect(await bcrypt.compare("changed-pass-2", mocks.store.data.password)).toBe(true);
    expect(mocks.store.data.tokenVersion).toBe(1);
  });

  it("rejects a new password shorter than 8 characters", async () => {
    mocks.store.data.password = await bcrypt.hash("old-pass-123", 10);
    const res = await PATCH(makeRequest({ currentPassword: "old-pass-123", newPassword: "short" }));
    expect(res.status).toBe(400);
    expect(await bcrypt.compare("old-pass-123", mocks.store.data.password)).toBe(true);
  });
});
