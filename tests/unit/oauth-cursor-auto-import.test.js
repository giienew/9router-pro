import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fsPromises from "fs/promises";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

// Mock next/server
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

// The route reads Cursor's db from homedir(); point it at a real temp dir
// where the tests create a REAL state.vscdb with the real better-sqlite3.
const TMP_HOME = "/tmp/cursor-autoimport-test";
const DB_PATH = join(TMP_HOME, "Library/Application Support/Cursor/User/globalStorage/state.vscdb");

vi.mock("os", () => ({
  default: { homedir: vi.fn(() => TMP_HOME) },
  homedir: vi.fn(() => TMP_HOME),
}));

// Mock fs/promises access only (probing); the db file itself is real.
vi.mock("fs/promises", () => ({
  access: vi.fn(),
  constants: { R_OK: 4 },
}));

// Mock child_process so the sqlite3-CLI fallback and `which cursor` are
// deterministically unavailable (no real CLI runs in tests).
vi.mock("child_process", () => ({
  execFile: vi.fn((file, args, options, callback) => {
    const cb = typeof options === "function" ? options : callback;
    cb(new Error("mocked cli unavailable"));
  }),
}));

// NOTE: the route loads better-sqlite3 via require(), which bypasses
// vitest's mock registry and always loads the real native binding. That is
// why these tests use a REAL temp db instead of a mocked one — it also
// means strategy 1 is covered for real, including the LIKE fallback.

// We need to dynamically import after mocks are registered
let GET;

function createDb(rows) {
  mkdirSync(join(TMP_HOME, "Library/Application Support/Cursor/User/globalStorage"), { recursive: true });
  const db = new Database(DB_PATH);
  db.exec("CREATE TABLE IF NOT EXISTS itemTable (key TEXT, value TEXT)");
  const insert = db.prepare("INSERT INTO itemTable (key, value) VALUES (?, ?)");
  for (const [key, value] of rows) insert.run(key, value);
  db.close();
}

describe("GET /api/oauth/cursor/auto-import", () => {
  const originalPlatform = process.platform;

  beforeEach(async () => {
    vi.clearAllMocks();
    rmSync(TMP_HOME, { recursive: true, force: true });
    // Force darwin so macOS-specific logic is exercised
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    // Re-import to pick up fresh mocks each run
    const mod = await import("../../src/app/api/oauth/cursor/auto-import/route.js");
    GET = mod.GET;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    rmSync(TMP_HOME, { recursive: true, force: true });
  });

  // ── macOS path probing ────────────────────────────────────────────────

  it("returns not-found when no macOS cursor db paths are accessible", async () => {
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found");
    expect(response.body.error).toContain("Checked locations");
    expect(response.body.error).toContain(DB_PATH);
  });

  it("falls back to manual paste if macOS db file exists but is corrupt", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mkdirSync(join(TMP_HOME, "Library/Application Support/Cursor/User/globalStorage"), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(DB_PATH, "this is not a sqlite database");

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.windowsManual).toBe(true);
  });

  // ── Token extraction (real db) ────────────────────────────────────────

  it("extracts tokens using exact keys", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    createDb([
      ["cursorAuth/accessToken", "test-token"],
      ["storage.serviceMachineId", "test-machine-id"],
    ]);

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("test-token");
    expect(response.body.machineId).toBe("test-machine-id");
  });

  it("unwraps JSON-encoded string values", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    createDb([
      ["cursorAuth/accessToken", '"json-token"'],
      ["storage.serviceMachineId", '"json-machine-id"'],
    ]);

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("json-token");
    expect(response.body.machineId).toBe("json-machine-id");
  });

  // ── Fuzzy fallback (macOS only) ───────────────────────────────────────

  it("falls back to fuzzy key matching on macOS when exact keys are missing", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    createDb([
      ["cursorAuth/someOtherAccessTokenKey", "fallback-token"],
      ["storage.someMachineId", "fallback-machine"],
    ]);

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("fallback-token");
    expect(response.body.machineId).toBe("fallback-machine");
  });

  it("offers manual paste when tokens are missing even after fallback", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    createDb([]);

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.windowsManual).toBe(true);
  });

  // ── Linux probes both config paths ────────────────────────────────────

  it("linux probes config paths and reports checked locations when not found", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found");
    expect(response.body.error).toContain("Checked locations");
    expect(fsPromises.access).toHaveBeenCalled();
  });

  it("unsupported platform returns 400", async () => {
    Object.defineProperty(process, "platform", { value: "freebsd", writable: true });

    const response = await GET();

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Unsupported platform");
  });
});
