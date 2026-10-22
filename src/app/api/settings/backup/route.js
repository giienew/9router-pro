import { NextResponse } from "next/server";
import { exportDb, getSettings } from "@/lib/localDb";
import { createSnapshot, listSnapshots } from "@/lib/backup/autoBackup.js";
import { summarizeBackup, normalizeKeep } from "@/lib/backup/summary.js";

// GET /api/settings/backup — current-data summary, auto-backup settings
// state, and the snapshot list for the Settings page Backup card.
export async function GET() {
  try {
    const [payload, settings] = await Promise.all([exportDb(), getSettings()]);
    return NextResponse.json({
      summary: summarizeBackup(payload),
      lastBackupAt: settings.lastBackupAt || null,
      autoBackupEnabled: settings.autoBackupEnabled !== false,
      autoBackupKeep: normalizeKeep(settings.autoBackupKeep),
      snapshots: listSnapshots(),
    });
  } catch (error) {
    console.log("Error reading backup info:", error);
    return NextResponse.json({ error: "Failed to read backup info" }, { status: 500 });
  }
}

// POST /api/settings/backup — take a snapshot now.
export async function POST() {
  try {
    const snapshot = await createSnapshot("manual");
    return NextResponse.json({ success: true, snapshot });
  } catch (error) {
    console.log("Error creating backup snapshot:", error);
    return NextResponse.json({ error: "Failed to create backup snapshot" }, { status: 500 });
  }
}
