// 9Router Pro — automatic backups: full JSON snapshots of the database
// export, stored in DATA_DIR/auto-backups with a small index so the
// Settings page can list them without parsing every file. A scheduler
// takes one snapshot a day (settings: autoBackupEnabled / autoBackupKeep);
// snapshots restore through the normal import path, which takes its own
// pre-import safety backup first.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";
import { exportDb, getSettings, updateSettings } from "@/lib/localDb";
import { summarizeBackup, pruneSnapshotList, normalizeKeep } from "./summary.js";

export const AUTO_BACKUP_DIR = path.join(DATA_DIR, "auto-backups");
const INDEX_FILE = path.join(AUTO_BACKUP_DIR, "index.json");
const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 90 * 1000;

function ensureDir() {
  fs.mkdirSync(AUTO_BACKUP_DIR, { recursive: true });
}

function readIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeIndex(entries) {
  ensureDir();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(entries, null, 2));
}

export function listSnapshots() {
  return readIndex();
}

export async function createSnapshot(reason = "manual") {
  ensureDir();
  const payload = await exportDb();
  const createdAt = new Date().toISOString();
  const id = `auto-${createdAt.replace(/[.:]/g, "-")}`;
  const file = `${id}.json`;
  const content = JSON.stringify(payload);
  fs.writeFileSync(path.join(AUTO_BACKUP_DIR, file), content);

  const settings = await getSettings();
  const keep = normalizeKeep(settings.autoBackupKeep);
  const meta = {
    id,
    file,
    createdAt,
    reason,
    appVersion: payload.appVersion || null,
    sizeBytes: Buffer.byteLength(content),
    counts: summarizeBackup(payload).counts,
  };
  const { keep: kept, remove } = pruneSnapshotList([meta, ...readIndex()], keep);
  for (const old of remove) {
    try { fs.rmSync(path.join(AUTO_BACKUP_DIR, old.file), { force: true }); } catch {}
  }
  writeIndex(kept);
  try { await updateSettings({ lastBackupAt: createdAt }); } catch {}
  return meta;
}

export function readSnapshot(id) {
  const meta = readIndex().find((e) => e.id === id);
  if (!meta || typeof meta.file !== "string") return null;
  const full = path.join(AUTO_BACKUP_DIR, meta.file);
  if (!full.startsWith(AUTO_BACKUP_DIR + path.sep)) return null;
  try {
    return { meta, payload: JSON.parse(fs.readFileSync(full, "utf8")) };
  } catch {
    return null;
  }
}

// ---- scheduler -------------------------------------------------------------
// Same shape as the model-catalog sync: one timer chain per process, a
// startup delay so the server serves first, hourly checks, unref'd so it
// never keeps the process alive.
let timer = null;

export function startAutoBackupScheduler() {
  if (timer) return;
  if (String(process.env.AUTO_BACKUP || "").toLowerCase() === "off") return;

  const check = async () => {
    let attempted = false;
    try {
      const settings = await getSettings();
      if (settings.autoBackupEnabled !== false) {
        const latest = readIndex()[0];
        const age = latest
          ? Date.now() - new Date(latest.createdAt).getTime()
          : Number.POSITIVE_INFINITY;
        if (age >= DAY_MS) {
          attempted = true;
          const snap = await createSnapshot("scheduled");
          // Silent jobs need an outside signal: notify on success too, so a
          // missing success message is itself the alarm.
          const { sendNotification } = await import("@/lib/notify.js");
          await sendNotification("backup", { title: "Scheduled backup completed", detail: `snapshot ${snap?.id || "unknown"}` });
        }
      }
    } catch (e) {
      console.warn("[AutoBackup] check failed:", e?.message || e);
      if (attempted) {
        try {
          const { sendNotification } = await import("@/lib/notify.js");
          await sendNotification("backup", { title: "Scheduled backup FAILED", error: e?.message || e });
        } catch { /* notify is fail-open; the warn above already fired */ }
      }
    }
    timer = setTimeout(check, CHECK_INTERVAL_MS);
    timer.unref?.();
  };

  timer = setTimeout(check, STARTUP_DELAY_MS);
  timer.unref?.();
}
