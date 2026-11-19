// 9Router Pro — Admin maintenance lib (pro.29): deploy-tarball pruning.
// Run: npx vitest run pro/admin-maintenance-lib.test.js  (from tests/)
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("@/lib/backup/autoBackup.js", () => ({ AUTO_BACKUP_DIR: "/tmp/9r-admin-nope", listSnapshots: () => [] }));
vi.mock("@/lib/backup/summary.js", () => ({ pruneSnapshotList: () => ({ keep: [], remove: [] }), normalizeKeep: () => 3 }));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({}), updateSettings: async () => ({}) }));
vi.mock("@/lib/db/backup.js", () => ({ pruneOldBackups: vi.fn() }));

const { pruneDeployTarballs } = await import("../../src/lib/admin/maintenance.js");

function makeDirWithTarballs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-admin-tar-"));
  const now = Date.now();
  const files = [
    { name: "9router-pro-0.5.109-pro.26.tgz", ageMs: 4000, size: 100 },
    { name: "9router-pro-0.5.109-pro.27.tgz", ageMs: 3000, size: 200 },
    { name: "9router-pro-0.5.109-pro.28.tgz", ageMs: 2000, size: 300 },
    { name: "9router-pro-0.5.109-pro.29.tgz", ageMs: 1000, size: 400 },
    { name: "something-else.tgz", ageMs: 500, size: 999 },
    { name: "notes.txt", ageMs: 500, size: 50 },
  ];
  for (const f of files) {
    const full = path.join(dir, f.name);
    fs.writeFileSync(full, Buffer.alloc(f.size, 0x61));
    fs.utimesSync(full, new Date(now - f.ageMs), new Date(now - f.ageMs));
  }
  return { dir, files };
}

describe("pruneDeployTarballs", () => {
  it("keeps the newest two 9router-pro tarballs and deletes older ones", () => {
    const { dir } = makeDirWithTarballs();
    const out = pruneDeployTarballs(dir, 2);
    expect(out.kept).toEqual(["9router-pro-0.5.109-pro.29.tgz", "9router-pro-0.5.109-pro.28.tgz"]);
    expect(out.removed.map((r) => r.name).sort()).toEqual([
      "9router-pro-0.5.109-pro.26.tgz",
      "9router-pro-0.5.109-pro.27.tgz",
    ]);
    expect(out.freedBytes).toBe(300);
    expect(fs.existsSync(path.join(dir, "9router-pro-0.5.109-pro.29.tgz"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "9router-pro-0.5.109-pro.26.tgz"))).toBe(false);
  });

  it("never touches non-9router files", () => {
    const { dir } = makeDirWithTarballs();
    pruneDeployTarballs(dir, 2);
    expect(fs.existsSync(path.join(dir, "something-else.tgz"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "notes.txt"))).toBe(true);
  });

  it("is a no-op on a missing directory", () => {
    const out = pruneDeployTarballs("/tmp/9r-admin-does-not-exist-xyz", 2);
    expect(out.removed).toEqual([]);
    expect(out.freedBytes).toBe(0);
  });
});
