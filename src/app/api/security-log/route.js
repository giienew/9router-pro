import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAdapter } from "@/lib/db/driver.js";
import { listSecurityEvents } from "@/lib/trustEvents.js";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession.js";

export const dynamic = "force-dynamic";

// GET /api/security-log — R3 audit log. Dashboard-authenticated: unlike
// most dashboard data routes (guarded by dashboard chrome), this one
// requires a valid dashboard session cookie, because it exposes sign-in
// IPs and user agents.
export async function GET() {
  try {
    const store = await cookies();
    const token = store.get("auth_token")?.value || null;
    if (!(await verifyDashboardAuthToken(token))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const db = await getAdapter();
    return NextResponse.json({ events: listSecurityEvents(db) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}
