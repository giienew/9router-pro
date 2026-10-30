// 9Router Pro — markAccountUnavailable fails open when the DB is unusable.
// A locked/busy database on the hot path must degrade to in-memory state
// (the lock is lost) while the request still falls back — never a 500
// caused by bookkeeping. The DB file is a directory, so every adapter
// open/read fails and getAdapter throws. Run from tests/:
//   bun x vitest run unit/mark-unavailable-failopen.test.js
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let auth;
let tmpDir;
let warnings;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-failopen-"));
  // DB file as a directory: SQLite cannot open it, so getAdapter throws.
  fs.mkdirSync(path.join(tmpDir, "db", "data.sqlite"), { recursive: true });
  process.env.DATA_DIR = tmpDir;
  auth = await import("@/sse/services/auth.js");
  warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); return origWarn(...args); };
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* throwaway dir */ }
});

describe("markAccountUnavailable fail-open", () => {
  it("still reports fallback for a 429 when the DB is unusable", async () => {
    const res = await auth.markAccountUnavailable("conn-123", 429, "rate limited", "dahl", "dahl/model");
    assert.equal(res.shouldFallback, true);
    assert.ok(res.cooldownMs > 0);
    // Proof the fail-open catch ran (not a silent success): a warning was logged.
    assert.ok(warnings.some((w) => w.includes("markAccountUnavailable") || w.includes("persisting lock")));
  });

  it("still reports no-fallback for a non-fallbackable error even with the DB down", async () => {
    const res = await auth.markAccountUnavailable("conn-123", 400, "bad request", "dahl", "dahl/model");
    assert.equal(res.shouldFallback, false);
  });

  it("ignores noauth without touching the DB", async () => {
    const res = await auth.markAccountUnavailable("noauth", 429, "x", "dahl", "dahl/model");
    assert.deepEqual(res, { shouldFallback: false, cooldownMs: 0 });
  });
});
