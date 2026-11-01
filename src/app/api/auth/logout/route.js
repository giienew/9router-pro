import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { clearDashboardAuthCookie } from "@/lib/auth/dashboardSession";
import { getAdapter } from "@/lib/db/driver.js";
import { recordSecurityEvent } from "@/lib/trustEvents.js";
import { getClientIp } from "@/lib/auth/loginLimiter";

export async function POST(request) {
  const cookieStore = await cookies();
  clearDashboardAuthCookie(cookieStore);
  cookieStore.delete("oidc_state");
  cookieStore.delete("oidc_nonce");
  cookieStore.delete("oidc_code_verifier");
  // R3: logout audit (fire-and-forget).
  getAdapter()
    .then((db) => recordSecurityEvent(db, { event: "logout", ip: getClientIp(request) }))
    .catch(() => {});
  return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
}
