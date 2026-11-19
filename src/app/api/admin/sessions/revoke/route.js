import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings, updateSettings } from "@/lib/localDb";
import {
  getTokenVersion,
  setDashboardAuthCookie,
} from "@/lib/auth/dashboardSession.js";
import { requireDashboardAuth, logAdminEvent } from "@/lib/admin/requireAdmin.js";

export const dynamic = "force-dynamic";

// POST /api/admin/sessions/revoke — revoke ALL dashboard sessions except
// the caller's own. Same mechanism as a password change (S1): bump the
// settings tokenVersion epoch, so every token issued before the bump fails
// verification, then re-issue the caller's cookie so the admin who clicked
// stays logged in. No session store is invented — the epoch IS the store.
export async function POST(request) {
  try {
    if (!(await requireDashboardAuth())) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const settings = await getSettings();
    const tokenVersion = getTokenVersion(settings) + 1;
    await updateSettings({ tokenVersion });
    try {
      const cookieStore = await cookies();
      await setDashboardAuthCookie(cookieStore, request);
    } catch {}
    await logAdminEvent("admin-sessions-revoked", `All dashboard sessions revoked (token epoch → ${tokenVersion}); caller re-issued a fresh session.`);
    return NextResponse.json({ success: true, revoked: true, tokenVersion });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}
