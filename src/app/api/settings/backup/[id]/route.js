import { NextResponse } from "next/server";
import { getSettings, importDb } from "@/lib/localDb";
import { readSnapshot } from "@/lib/backup/autoBackup.js";
import { verifyDashboardPassword } from "@/lib/auth/dashboardSession";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";

const PASSWORD_HEADER = "x-9r-password";

// GET /api/settings/backup/[id] — download one snapshot's payload.
// Gated by the dashboard password, same as a database export.
export async function GET(request, { params }) {
  try {
    if (!(await verifyDashboardPassword(request.headers.get(PASSWORD_HEADER)))) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }
    const { id } = await params;
    const found = readSnapshot(id);
    if (!found) {
      return NextResponse.json({ error: "Snapshot not found" }, { status: 404 });
    }
    return NextResponse.json(found.payload);
  } catch (error) {
    console.log("Error downloading backup snapshot:", error);
    return NextResponse.json({ error: "Failed to download snapshot" }, { status: 500 });
  }
}

// POST /api/settings/backup/[id] — restore one snapshot. The import path
// takes its own pre-import safety backup, so a restore is recoverable.
export async function POST(request, { params }) {
  try {
    const { password, applySections } = await request.json().catch(() => ({}));
    if (!(await verifyDashboardPassword(password))) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }
    const { id } = await params;
    const found = readSnapshot(id);
    if (!found) {
      return NextResponse.json({ error: "Snapshot not found" }, { status: 404 });
    }
    await importDb(found.payload, { sections: applySections });
    try {
      const settings = await getSettings();
      applyOutboundProxyEnv(settings);
    } catch (err) {
      console.warn("[Settings][BackupRestore] Failed to re-apply outbound proxy env:", err);
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error restoring backup snapshot:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to restore snapshot" },
      { status: 400 }
    );
  }
}
