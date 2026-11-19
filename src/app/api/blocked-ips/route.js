import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAdapter } from "@/lib/db/driver.js";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession.js";
import {
  blockIp,
  isIpBlocked,
  listBlockedIps,
  logBlockedIpAction,
  unblockIp,
} from "@/lib/spamAbuse.js";
import { isBlockableIp, normalizeIp } from "@/shared/utils/clientMeta.js";

export const dynamic = "force-dynamic";

async function requireDashboardAuth() {
  const store = await cookies();
  const token = store.get("auth_token")?.value || null;
  return verifyDashboardAuthToken(token);
}

// GET /api/blocked-ips — list blacklisted IPs.
// POST /api/blocked-ips { ip, country? } — blacklist an IP.
// DELETE /api/blocked-ips?ip=1.2.3.4 — unblacklist an IP.
// Dashboard-authenticated. Block/unblock actions are written to the
// security log (who/when/IP) so the admin can audit them. The dashboard
// login route never consults this list, so blocking an IP can never lock
// the admin out of the dashboard.
export async function GET() {
  try {
    if (!(await requireDashboardAuth())) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ blocked: await listBlockedIps() }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    if (!(await requireDashboardAuth())) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const body = await request.json().catch(() => ({}));
    const ip = normalizeIp(body?.ip);
    if (!isBlockableIp(ip)) {
      return NextResponse.json({ error: "Invalid IP address" }, { status: 400 });
    }
    const entry = await blockIp(ip, { country: body?.country, reason: body?.reason || null });
    const db = await getAdapter();
    logBlockedIpAction(db, { action: "block", ip });
    return NextResponse.json({ blocked: entry }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    if (!(await requireDashboardAuth())) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { searchParams } = new URL(request.url);
    const ip = normalizeIp(searchParams.get("ip"));
    if (!isBlockableIp(ip)) {
      return NextResponse.json({ error: "Invalid IP address" }, { status: 400 });
    }
    if (!(await isIpBlocked(ip))) {
      return NextResponse.json({ error: "IP is not blocked" }, { status: 404 });
    }
    await unblockIp(ip);
    const db = await getAdapter();
    logBlockedIpAction(db, { action: "unblock", ip });
    return NextResponse.json({ unblocked: ip });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}
