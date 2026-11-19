import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { SignJWT } from "jose";

// Test JWT secret + data dir must be set BEFORE dashboardSession loads
// (it reads the secret once at module load).
process.env.JWT_SECRET = "test-jwt-secret-for-auth-unit-tests-only";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "9r-auth-test-"));

const store = vi.hoisted(() => ({ data: {} }));

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ ...store.data })),
  updateSettings: vi.fn(async (updates) => {
    store.data = { ...store.data, ...updates };
    return { ...store.data };
  }),
}));

const dashboardSession = await import("../../src/lib/auth/dashboardSession.js");
const { TextEncoder } = globalThis;

describe("dashboardSession: bcrypt-only password verification", () => {
  beforeEach(() => {
    store.data = {};
    delete process.env.INITIAL_PASSWORD;
    vi.clearAllMocks();
  });

  it("verifies a bcrypt-hashed password and rejects a wrong one", async () => {
    store.data.password = await bcrypt.hash("correct-horse-123", 10);
    expect(await dashboardSession.verifyDashboardPassword("correct-horse-123")).toBe(true);
    expect(await dashboardSession.verifyDashboardPassword("wrong-password")).toBe(false);
  });

  it("fails closed on a legacy plaintext stored value (never verifies as-is)", async () => {
    store.data.password = "legacy-plaintext-pass";
    expect(await dashboardSession.verifyStoredPassword("legacy-plaintext-pass", store.data.password)).toBe(false);
    expect(await dashboardSession.verifyDashboardPassword("legacy-plaintext-pass")).toBe(true);
    // ...because verifyDashboardPassword migrates first, then verifies by bcrypt:
    expect(store.data.password).not.toBe("legacy-plaintext-pass");
    expect(dashboardSession.isBcryptHash(store.data.password)).toBe(true);
  });

  it("migrates a legacy plaintext stored password in place (same password keeps working)", async () => {
    store.data.password = "legacy-plaintext-pass";
    const migrated = await dashboardSession.ensurePasswordReady();
    expect(migrated.password).not.toBe("legacy-plaintext-pass");
    expect(dashboardSession.isBcryptHash(migrated.password)).toBe(true);
    expect(await bcrypt.compare("legacy-plaintext-pass", migrated.password)).toBe(true);
    expect(await dashboardSession.verifyDashboardPassword("legacy-plaintext-pass")).toBe(true);
    expect(await dashboardSession.verifyDashboardPassword("other-password")).toBe(false);
  });

  it("hashes INITIAL_PASSWORD into settings.password on first boot, never storing it plaintext", async () => {
    process.env.INITIAL_PASSWORD = "env-initial-pass-9";
    const migrated = await dashboardSession.ensurePasswordReady();
    expect(migrated.password).not.toBe("env-initial-pass-9");
    expect(dashboardSession.isBcryptHash(migrated.password)).toBe(true);
    expect(await dashboardSession.verifyDashboardPassword("env-initial-pass-9")).toBe(true);
    expect(await dashboardSession.verifyDashboardPassword("wrong")).toBe(false);
  });

  it("does not overwrite an existing bcrypt hash with INITIAL_PASSWORD", async () => {
    store.data.password = await bcrypt.hash("existing-pass-1", 10);
    process.env.INITIAL_PASSWORD = "env-initial-pass-9";
    const settings = await dashboardSession.ensurePasswordReady();
    expect(await bcrypt.compare("existing-pass-1", settings.password)).toBe(true);
    expect(await dashboardSession.verifyDashboardPassword("env-initial-pass-9")).toBe(false);
  });

  it("fails closed when no password is configured and no env value is set", async () => {
    const settings = await dashboardSession.ensurePasswordReady();
    expect(settings.password).toBeUndefined();
    expect(await dashboardSession.verifyDashboardPassword("anything")).toBe(false);
    expect(await dashboardSession.verifyDashboardPassword("")).toBe(false);
  });
});

describe("dashboardSession: session revocation on password change", () => {
  beforeEach(() => {
    store.data = {};
    delete process.env.INITIAL_PASSWORD;
    vi.clearAllMocks();
  });

  it("a token issued before a tokenVersion bump FAILS, a fresh token passes", async () => {
    store.data.password = await bcrypt.hash("admin-pass-123", 10);
    const oldToken = await dashboardSession.createDashboardAuthToken();
    expect(await dashboardSession.verifyDashboardAuthToken(oldToken)).toBe(true);
    expect(await dashboardSession.getDashboardAuthSession(oldToken)).not.toBeNull();

    // Simulate a password change (settings PATCH bumps tokenVersion).
    store.data.tokenVersion = 1;

    expect(await dashboardSession.verifyDashboardAuthToken(oldToken)).toBe(false);
    expect(await dashboardSession.getDashboardAuthSession(oldToken)).toBeNull();

    const freshToken = await dashboardSession.createDashboardAuthToken();
    expect(await dashboardSession.verifyDashboardAuthToken(freshToken)).toBe(true);
    expect(await dashboardSession.getDashboardAuthSession(freshToken)).not.toBeNull();
  });

  it("a token issued before ANY password-hash change fails via fingerprint, even without a version bump", async () => {
    store.data.password = await bcrypt.hash("admin-pass-123", 10);
    const oldToken = await dashboardSession.createDashboardAuthToken();
    expect(await dashboardSession.verifyDashboardAuthToken(oldToken)).toBe(true);

    // Simulate the CLI reset-password path: password cleared, version untouched.
    store.data.password = null;

    expect(await dashboardSession.verifyDashboardAuthToken(oldToken)).toBe(false);
    const freshToken = await dashboardSession.createDashboardAuthToken();
    expect(await dashboardSession.verifyDashboardAuthToken(freshToken)).toBe(true);
  });

  it("a legacy pre-deploy token (no tv/ph claims) still verifies at epoch 0, then dies after a bump", async () => {
    store.data.password = await bcrypt.hash("admin-pass-123", 10);
    const legacyToken = await new SignJWT({ authenticated: true })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("24h")
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
    expect(await dashboardSession.verifyDashboardAuthToken(legacyToken)).toBe(true);

    store.data.tokenVersion = 1;
    expect(await dashboardSession.verifyDashboardAuthToken(legacyToken)).toBe(false);
  });

  it("a tampered or foreign token never verifies", async () => {
    store.data.password = await bcrypt.hash("admin-pass-123", 10);
    const token = await dashboardSession.createDashboardAuthToken();
    expect(await dashboardSession.verifyDashboardAuthToken(`${token}x`)).toBe(false);
    expect(await dashboardSession.verifyDashboardAuthToken("")).toBe(false);
    expect(await dashboardSession.verifyDashboardAuthToken(null)).toBe(false);
  });
});
