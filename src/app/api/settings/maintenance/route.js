import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { runMaintenanceNow } from "@/lib/db/maintenance.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const settings = await getSettings();
    return NextResponse.json({ config: settings.dbMaintenance || {} }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}

export async function POST() {
  try {
    const result = await runMaintenanceNow();
    return NextResponse.json({ result });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}
