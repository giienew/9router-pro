// 9Router Pro — Admin menu (pro.29) tests.
// Run: npx vitest run pro/admin-menu.test.js  (from tests/)
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatBytes, resolvePm2Target } from "../../src/shared/utils/adminHelpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// --- pure helpers -----------------------------------------------------------
describe("formatBytes", () => {
  it("formats B/KB/MB/GB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3 MB");
    expect(formatBytes(2.5 * 1024 ** 3)).toBe("2.5 GB");
  });
});

describe("resolvePm2Target", () => {
  const jlist = [
    { name: "other-app", pid: 11, pm2_env: { status: "online", pm_exec_path: "/srv/other.js" } },
    { name: "9router", pid: 22, pm2_env: { status: "online", pm_exec_path: "/root/9router-pro/server.js" } },
    { name: "9router-pro", pid: 33, pm2_env: { status: "online", pm_exec_path: "/root/9router-pro/server.js" } },
  ];
  it("prefers the exact 9router-pro process", () => {
    expect(resolvePm2Target(jlist)).toEqual({ name: "9router-pro", status: "online", pid: 33 });
  });
  it("falls back to any 9router process", () => {
    expect(resolvePm2Target(jlist.slice(0, 2)).name).toBe("9router");
  });
  it("returns null when PM2 runs no 9router process", () => {
    expect(resolvePm2Target(jlist.slice(0, 1))).toBeNull();
    expect(resolvePm2Target([])).toBeNull();
    expect(resolvePm2Target(null)).toBeNull();
  });
});

// --- source assertions: the Admin surface exists and stays masked-only ----
describe("Admin surface (source assertions)", () => {
  it("Sidebar links Admin + Spam next to Usage", () => {
    const src = readSrc("src/shared/components/Sidebar.js");
    const usage = src.indexOf('"/dashboard/usage"');
    const admin = src.indexOf('"/dashboard/admin"');
    const spam = src.indexOf('"/dashboard/spam"');
    expect(usage).toBeGreaterThan(-1);
    expect(admin).toBeGreaterThan(usage);
    expect(spam).toBeGreaterThan(usage);
    expect(src).toContain('"Admin"');
    expect(src).toContain('"Spam"');
  });

  it("Admin page embeds the spam manager instead of rebuilding it", () => {
    const src = readSrc("src/app/(dashboard)/dashboard/admin/AdminClient.js");
    expect(src).toContain("SpamRankingClient");
    expect(src).toContain("../spam/SpamRankingClient");
  });

  it("Admin client keeps the key manager (control room) and drops only Logs + shortcuts", () => {
    const src = readSrc("src/app/(dashboard)/dashboard/admin/AdminClient.js");
    // Admin is the control room: key manager, security, spam, maintenance stay.
    for (const section of ["System status", "Security center", "Key management", "Maintenance"]) {
      expect(src).toContain(section);
    }
    // Spam ranking lives inside the embedded SpamRankingClient (own title there).
    expect(src).toContain("SpamRankingClient");
    expect(src).toContain("keyMasked");
    expect(src).not.toMatch(/\bk\.key\b/);
    // True duplicates only: Logs lives in Console Log, shortcuts are a link list.
    expect(src).not.toContain("Settings shortcuts");
    expect(src).not.toContain('title="Logs"');
    expect(src).not.toContain("SETTING_LINKS");
    expect(src).toContain("ConfirmModal");
    expect(src).toContain("Revoke other sessions");
    expect(src).toContain("Restart the app");
  });

  it("maintenance route is dashboard-gated, logs every action, and covers all actions", () => {
    const src = readSrc("src/app/api/admin/maintenance/route.js");
    expect(src).toContain("requireDashboardAuth");
    expect(src).toContain("logAdminEvent");
    for (const action of ["clear-semantic", "clear-models", "clear-latency", "clear-all-caches", "clear-logs", "clear-pm2-logs", "reset-breakers", "vacuum", "backup-now", "disk-cleanup", "refresh-tokens", "restart"]) {
      expect(src).toContain(`"${action}"`);
    }
    expect(src).toContain("__resetProviderBreakers");
    expect(src).toContain("invalidateSemanticEntries");
  });

  it("sessions revoke bumps the token epoch and re-issues the caller", () => {
    const src = readSrc("src/app/api/admin/sessions/revoke/route.js");
    expect(src).toContain("tokenVersion");
    expect(src).toContain("setDashboardAuthCookie");
    expect(src).toContain("requireDashboardAuth");
  });

  it("security route reads the at-rest encryption status", () => {
    const src = readSrc("src/app/api/admin/security/route.js");
    expect(src).toContain("isKeyConfigured");
    expect(src).toContain("countRowEncryption");
    expect(src).toContain("loginLockouts");
  });
});

// --- route auth: unauthenticated / API-key callers get 401 ------------------
const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  cookieStore: { get: () => undefined },
  store: { data: { tokenVersion: 3 } },
  dbAll: vi.fn(() => []),
  recordSecurityEvent: vi.fn(),
  invalidateSemanticEntries: vi.fn(() => 7),
  findPm2Target: vi.fn(async () => ({ available: false, target: null })),
  schedulePm2Restart: vi.fn(),
  setDashboardAuthCookie: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: mocks.json } }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => mocks.cookieStore) }));
vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: vi.fn(async (t) => t === "valid-token"),
  getTokenVersion: vi.fn((s) => (Number.isInteger(s?.tokenVersion) ? s.tokenVersion : 0)),
  setDashboardAuthCookie: mocks.setDashboardAuthCookie,
  getDashboardAuthSession: vi.fn(async (t) => (t === "valid-token" ? { iat: 1700000000, exp: 1700086400 } : null)),
}));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: vi.fn(async () => ({ all: mocks.dbAll, run: vi.fn() })) }));
vi.mock("@/lib/trustEvents.js", () => ({ recordSecurityEvent: mocks.recordSecurityEvent }));
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ ...mocks.store.data })),
  updateSettings: vi.fn(async (u) => { mocks.store.data = { ...mocks.store.data, ...u }; return { ...mocks.store.data }; }),
}));
vi.mock("@/lib/auth/loginLimiter.js", () => ({ recordSuccess: vi.fn() }));
vi.mock("@/lib/semanticCache.js", () => ({ invalidateSemanticEntries: mocks.invalidateSemanticEntries }));
vi.mock("@/sse/services/modelsListCache.js", () => ({ invalidateModelsListCache: vi.fn() }));
vi.mock("@/lib/userModelCaps.js", () => ({ invalidateUserModelCaps: vi.fn() }));
vi.mock("@/sse/services/providerBreaker.js", () => ({
  getProviderBreakerSnapshot: vi.fn(() => ({ a: {}, b: {} })),
  __resetProviderBreakers: vi.fn(),
}));
vi.mock("@/lib/consoleLogBuffer.js", () => ({ getConsoleLogs: vi.fn(() => ["l1", "l2"]), clearConsoleLogs: vi.fn() }));
vi.mock("@/lib/backup/autoBackup.js", () => ({ createSnapshot: vi.fn(async () => ({ id: "auto-x", file: "auto-x.json" })) }));
vi.mock("@/lib/admin/maintenance.js", () => ({
  diskCleanup: vi.fn(async () => ({ freedBytes: 123 })),
  findPm2Target: mocks.findPm2Target,
  schedulePm2Restart: mocks.schedulePm2Restart,
  flushPm2Logs: vi.fn(async () => ({ ok: true, error: null })),
}));
vi.mock("@/lib/db/paths.js", () => ({ DATA_FILE: "/tmp/9r-admin-test-data.sqlite" }));
vi.mock("@/lib/db/repos/connectionsRepo.js", () => ({ getProviderConnections: vi.fn(async () => []) }));
vi.mock("@/sse/services/backgroundTokenRefresh.js", () => ({
  selectConnectionsNeedingRefresh: vi.fn(() => []),
  runBackgroundTokenRefreshTick: vi.fn(async () => {}),
}));
vi.mock("@/app/api/usage/latency/route.js", () => ({ __clearLatencyCache: vi.fn(() => 2) }));
vi.mock("@/app/api/monitoring/route.js", () => ({ __clearMonitoringCache: vi.fn(() => 1) }));

const { POST: maintenancePOST } = await import("../../src/app/api/admin/maintenance/route.js");
const { POST: revokePOST } = await import("../../src/app/api/admin/sessions/revoke/route.js");
const { GET: securityGET } = await import("../../src/app/api/admin/security/route.js");

function authed() {
  mocks.cookieStore = { get: (name) => (name === "auth_token" ? { value: "valid-token" } : undefined) };
}
function unauthed() {
  mocks.cookieStore = { get: () => undefined };
}
const req = (body) => ({ json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.store.data = { tokenVersion: 3 };
  unauthed();
});

describe("POST /api/admin/maintenance — auth gate", () => {
  it("401 without a dashboard session (API-key callers included)", async () => {
    const res = await maintenancePOST(req({ action: "clear-semantic" }));
    expect(res.status).toBe(401);
    expect(mocks.invalidateSemanticEntries).not.toHaveBeenCalled();
  });

  it("400 for an unknown action when authed", async () => {
    authed();
    const res = await maintenancePOST(req({ action: "explode" }));
    expect(res.status).toBe(400);
  });

  it("clear-semantic returns the removed count and logs a security event", async () => {
    authed();
    const res = await maintenancePOST(req({ action: "clear-semantic" }));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.result.removed).toBe(7);
    expect(mocks.recordSecurityEvent).toHaveBeenCalled();
  });

  it("restart without PM2 is a 503 and never schedules a restart", async () => {
    authed();
    mocks.findPm2Target.mockResolvedValueOnce({ available: false, target: null });
    const res = await maintenancePOST(req({ action: "restart" }));
    expect(res.status).toBe(503);
    expect(mocks.schedulePm2Restart).not.toHaveBeenCalled();
  });

  it("restart with a PM2 target schedules a graceful restart", async () => {
    authed();
    mocks.findPm2Target.mockResolvedValueOnce({
      available: true,
      target: { name: "9router-pro", status: "online", pid: 42 },
    });
    const res = await maintenancePOST(req({ action: "restart" }));
    expect(res.status).toBe(200);
    expect(res.body.restarting).toBe(true);
    expect(res.body.process).toBe("9router-pro");
    expect(mocks.schedulePm2Restart).toHaveBeenCalledWith("9router-pro");
  });
});

describe("POST /api/admin/sessions/revoke — auth gate + epoch bump", () => {
  it("401 without a dashboard session", async () => {
    const res = await revokePOST(req({}));
    expect(res.status).toBe(401);
    expect(mocks.store.data.tokenVersion).toBe(3);
  });

  it("bumps tokenVersion and re-issues the caller's cookie", async () => {
    authed();
    const res = await revokePOST(req({}));
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(true);
    expect(res.body.tokenVersion).toBe(4);
    expect(mocks.store.data.tokenVersion).toBe(4);
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalled();
  });
});

describe("GET /api/admin/security — encryption counts come from raw rows", () => {
  it("401 without a dashboard session", async () => {
    const res = await securityGET();
    expect(res.status).toBe(401);
  });

  it("counts encrypted vs plaintext from the stored data column", async () => {
    authed();
    const envelope = JSON.stringify({ v: 1, iv: "aGVsbG8=", tag: "d29ybGQ=", data: "c2VjcmV0" });
    mocks.dbAll.mockImplementation((sql) => {
      if (String(sql).includes("loginLockouts")) {
        return [{ ip: "203.0.113.9", fails: 0, lockUntil: Date.now() + 60000, lockLevel: 1, lastFailAt: Date.now() }];
      }
      return [{ data: JSON.stringify({ apiKey: "plain-key", accessToken: envelope }) }];
    });
    const res = await securityGET();
    expect(res.status).toBe(200);
    expect(res.body.encryption.configured).toBe(false);
    expect(res.body.encryption.plaintext).toBe(1);
    expect(res.body.encryption.encrypted).toBe(1);
    expect(res.body.lockouts).toHaveLength(1);
    expect(res.body.lockouts[0].locked).toBe(true);
    expect(res.body.sessions.tokenVersion).toBe(3);
  });
});
