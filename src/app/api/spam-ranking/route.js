import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession.js";
import { getSpamRanking, getRecentSpamLog, listBlockedIps } from "@/lib/spamAbuse.js";

export const dynamic = "force-dynamic";

const VALID_PERIODS = new Set(["24h", "7d", "30d", "all"]);

// GET /api/spam-ranking?period=7d&limit=50 — Abuse/Spam ranking.
// Dashboard-authenticated (same guard as /api/security-log): the payload
// carries client IPs and masked API keys. Masked keys only — a full key
// never appears in this response.
export async function GET(request) {
  try {
    const store = await cookies();
    const token = store.get("auth_token")?.value || null;
    if (!(await verifyDashboardAuthToken(token))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { searchParams } = new URL(request.url);
    const period = VALID_PERIODS.has(searchParams.get("period")) ? searchParams.get("period") : "7d";
    const limit = Math.min(200, Math.max(1, Math.floor(Number(searchParams.get("limit"))) || 50));
    const [ranking, recent, blocked] = await Promise.all([
      getSpamRanking({ period, limit }),
      getRecentSpamLog({ limit: 50 }),
      listBlockedIps(),
    ]);
    return NextResponse.json(
      { ...ranking, recent, blocked },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}
