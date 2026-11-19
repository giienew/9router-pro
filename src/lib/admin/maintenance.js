// Admin maintenance helpers (9Router Pro, pro.29) — server-only filesystem
// work behind POST /api/admin/maintenance. Every destructive action is
// gated by dashboard auth + a security-log entry in the route; these
// helpers only do the work and report what changed.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { DATA_DIR } from "@/lib/dataDir.js";
import { BACKUPS_DIR } from "@/lib/db/paths.js";
import { pruneOldBackups } from "@/lib/db/backup.js";
import { AUTO_BACKUP_DIR, listSnapshots } from "@/lib/backup/autoBackup.js";
import { pruneSnapshotList, normalizeKeep } from "@/lib/backup/summary.js";
import { getSettings } from "@/lib/localDb";
import { resolvePm2Target } from "@/shared/utils/adminHelpers.js";

const TARBALL_RE = /^9router-pro-.*\.tgz$/;

// Deploy tarballs live in the app directory on a PM2 host (/root on the
// live VPS, the repo root on a dev box). Only 9Router-Pro tarballs are ever
// touched; anything else in the directory is left alone.
export function deployTarballDirs() {
  const dirs = [process.cwd()];
  if (path.resolve("/root") !== path.resolve(process.cwd())) dirs.push("/root");
  return dirs.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

// Keep the newest `keep` tarballs in `dir`, delete the rest.
// Returns { dir, kept, removed: [{ name, sizeBytes }], freedBytes }.
export function pruneDeployTarballs(dir, keep = 2) {
  const out = { dir, kept: [], removed: [], freedBytes: 0 };
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  const tarballs = entries
    .filter((e) => e.isFile() && TARBALL_RE.test(e.name))
    .map((e) => {
      const full = path.join(dir, e.name);
      let mtime = 0;
      let sizeBytes = 0;
      try { const s = fs.statSync(full); mtime = s.mtimeMs; sizeBytes = s.size; } catch {}
      return { name: e.name, full, mtime, sizeBytes };
    })
    .sort((a, b) => b.mtime - a.mtime);
  out.kept = tarballs.slice(0, keep).map((t) => t.name);
  for (const t of tarballs.slice(keep)) {
    try {
      fs.rmSync(t.full, { force: true });
      out.removed.push({ name: t.name, sizeBytes: t.sizeBytes });
      out.freedBytes += t.sizeBytes;
    } catch {}
  }
  return out;
}

export function dirSizeBytes(dir) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      try {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) total += dirSizeBytes(full);
        else total += fs.statSync(full).size;
      } catch {}
    }
  } catch {}
  return total;
}

function listBackupDirs() {
  try {
    return fs.readdirSync(BACKUPS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch { return []; }
}

// Disk cleanup: old deploy tarballs (keep current + previous) + old DB
// safety backups (keep 3, the standing rule) + old auto-backup snapshots
// (keep per settings.autoBackupKeep). The restore path is never touched:
// the newest backups always survive, and only files under the two backup
// dirs and 9router-pro tarballs are ever deleted.
export async function diskCleanup() {
  const tarballs = deployTarballDirs().map((d) => pruneDeployTarballs(d, 2));

  const beforeBackupDirs = listBackupDirs();
  const beforeBackupBytes = dirSizeBytes(BACKUPS_DIR);
  try { pruneOldBackups(); } catch {}
  const afterBackupDirs = listBackupDirs();
  const removedBackupDirs = beforeBackupDirs.filter((n) => !afterBackupDirs.includes(n));

  let snapshotsRemoved = [];
  let freedSnapshotBytes = 0;
  try {
    const settings = await getSettings().catch(() => null);
    const keep = normalizeKeep(settings?.autoBackupKeep);
    const { keep: kept, remove } = pruneSnapshotList(listSnapshots(), keep);
    for (const old of remove) {
      const full = path.join(AUTO_BACKUP_DIR, old.file || "");
      if (!old.file || !full.startsWith(AUTO_BACKUP_DIR + path.sep)) continue;
      try {
        const size = fs.statSync(full).size;
        fs.rmSync(full, { force: true });
        snapshotsRemoved.push(old.file);
        freedSnapshotBytes += size;
      } catch {}
    }
    if (remove.length) {
      try { fs.writeFileSync(path.join(AUTO_BACKUP_DIR, "index.json"), JSON.stringify(kept, null, 2)); } catch {}
    }
  } catch {}

  const freedTarballBytes = tarballs.reduce((s, t) => s + t.freedBytes, 0);
  const freedBackupBytes = Math.max(0, beforeBackupBytes - dirSizeBytes(BACKUPS_DIR));
  return {
    tarballs,
    removedBackupDirs,
    removedSnapshots: snapshotsRemoved,
    freedBytes: freedTarballBytes + freedBackupBytes + freedSnapshotBytes,
    freedTarballBytes,
    freedBackupBytes,
    freedSnapshotBytes,
  };
}

// --- PM2 -----------------------------------------------------------------
function execFileAsync(file, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) resolve({ ok: false, error: err?.message || String(err), stdout: String(stdout || "") });
      else resolve({ ok: true, stdout: String(stdout || "") });
    });
  });
}

// Find the PM2 process running 9Router Pro, if PM2 exists on this host.
export async function findPm2Target() {
  const res = await execFileAsync("pm2", ["jlist"]);
  if (!res.ok) return { available: false, target: null, processes: [], error: res.error };
  let list = null;
  try { list = JSON.parse(res.stdout); } catch { return { available: false, target: null, processes: [], error: "pm2 jlist was not JSON" }; }
  const target = resolvePm2Target(list);
  return {
    available: true,
    target,
    processes: (Array.isArray(list) ? list : []).map((p) => ({ name: String(p?.name || ""), status: String(p?.pm2_env?.status || ""), pid: Number(p?.pid) || null })),
  };
}

// Schedule a graceful PM2 restart of the 9Router process. The caller must
// already have sent its HTTP response: the restart kills this process, so
// it is fired from a short timer after the response is flushed.
export function schedulePm2Restart(name) {
  const timer = setTimeout(() => {
    execFile("pm2", ["restart", name], { timeout: 15000 }, () => {});
  }, 800);
  // Do not unref: the timer must survive long enough to spawn pm2 even
  // though the response has already gone out.
  return timer;
}

// Truncate PM2's on-disk logs for every process (`pm2 flush`). Returns
// { ok, error? }. Only meaningful when PM2 manages this host.
export async function flushPm2Logs() {
  const res = await execFileAsync("pm2", ["flush"], 15000);
  return { ok: res.ok, error: res.ok ? null : res.error };
}

export function dataDir() { return DATA_DIR; }
