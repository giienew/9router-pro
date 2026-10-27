import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getLatencyStats } from "@/lib/latencyStats.js";

export const dynamic = "force-dynamic";

const PERIOD_MS = { "24h": 24 * 3600 * 1000, "7d": 7 * 24 * 3600 * 1000, "30d": 30 * 24 * 3600 * 1000 };

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";
    const since = PERIOD_MS[period] ? new Date(Date.now() - PERIOD_MS[period]).toISOString() : null;
    const db = await getAdapter();
    const stats = await getLatencyStats(db, since);
    return NextResponse.json({ period, ...stats }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}
