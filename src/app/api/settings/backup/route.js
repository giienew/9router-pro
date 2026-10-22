import { NextResponse } from "next/server";
import { exportDb, getSettings } from "@/lib/localDb";
import { createSnapshot, listSnapshots } from "@/lib/backup/autoBackup.js";
import { summarizeBackup, normalizeKeep } from "@/lib/backup/summary.js";

// GET /api/settings/backup — current-data summary, auto-backup settings
// state, and the snapshot list for the Settings page Backup card.
export async function GET() {
  try {
    const [payload, settings] = await Promise.all([exportDb(), getSettings()]);
    // Per-provider connection counts for the selective-backup checklist.
    const nodeNames = new Map((payload.providerNodes || []).map((n) => [n.id, n.name]));
    const byProvider = new Map();
    for (const c of payload.providerConnections || []) {
      byProvider.set(c.provider, (byProvider.get(c.provider) || 0) + 1);
    }
    const providers = [...byProvider.entries()]
      .map(([id, connections]) => ({ id, name: nodeNames.get(id) || null, connections }))
      .sort((a, b) => b.connections - a.connections)
      .slice(0, 100);
    return NextResponse.json({
      summary: summarizeBackup(payload),
      providers,
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
