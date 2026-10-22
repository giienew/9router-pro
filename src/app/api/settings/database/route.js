import { NextResponse } from "next/server";
import { exportDb, getSettings, importDb, updateSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { verifyDashboardPassword } from "@/lib/auth/dashboardSession";
import { summarizeBackup, sanitizeSections, sanitizeProviders } from "@/lib/backup/summary.js";

const CLI_TOKEN_HEADER = "x-9r-cli-token";
const PASSWORD_HEADER = "x-9r-password";

// CLI token requests are already trusted (local machine); skip password re-auth.
function isCliRequest(request) {
  return Boolean(request.headers.get(CLI_TOKEN_HEADER));
}

export async function GET(request) {
  try {
    if (!isCliRequest(request) && !(await verifyDashboardPassword(request.headers.get(PASSWORD_HEADER)))) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }
    // Selective export: ?sections=combos,apiKeys and/or
    // ?providers=dahl,codex limit what the file carries.
    const params = request.nextUrl.searchParams;
    const sections = sanitizeSections((params.get("sections") || "").split(",").filter(Boolean));
    const providers = sanitizeProviders((params.get("providers") || "").split(",").filter(Boolean));
    const payload = await exportDb({ sections, providers });
    // Only a full download counts as the last backup for the Settings card.
    if (!sections && !providers) {
      try { await updateSettings({ lastBackupAt: new Date().toISOString() }); } catch {}
    }
    return NextResponse.json(payload);
  } catch (error) {
    console.log("Error exporting database:", error);
    return NextResponse.json({ error: "Failed to export database" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    // Preview mode: summarize the file without importing anything, so the
    // UI can show exactly what an import would replace before it happens.
    if (body && body.preview === true) {
      const { password, preview, ...payload } = body;
      if (!isCliRequest(request) && !(await verifyDashboardPassword(password))) {
        return NextResponse.json({ error: "Invalid password" }, { status: 401 });
      }
      return NextResponse.json({ summary: summarizeBackup(payload) });
    }
    const { password, applySections, ...payload } = body;
    if (!isCliRequest(request) && !(await verifyDashboardPassword(password))) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }
    await importDb(payload, { sections: applySections });

    // Ensure proxy settings take effect immediately after a DB import.
    try {
      const settings = await getSettings();
      applyOutboundProxyEnv(settings);
    } catch (err) {
      console.warn("[Settings][DatabaseImport] Failed to re-apply outbound proxy env:", err);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error importing database:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to import database" },
      { status: 400 }
    );
  }
}
