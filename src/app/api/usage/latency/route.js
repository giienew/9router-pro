import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getLatencyStats } from "@/lib/latencyStats.js";
import { isObservabilityEnabled } from "@/lib/usageDb";

export const dynamic = "force-dynamic";

const PERIOD_MS = { "24h": 24 * 3600 * 1000, "7d": 7 * 24 * 3600 * 1000, "30d": 30 * 24 * 3600 * 1000 };

// m8: short cache like the stats route — the latency build parses up to
// 5,000 detail blobs per call, and the card refetches on every period
// change. 5s is invisible (the card shows aggregates, not live rows).
const CACHE_TTL_MS = 5000;
const cache = new Map();

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";
    const hit = cache.get(period);
    let stats;
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
      stats = hit.data;
    } else {
      const since = PERIOD_MS[period] ? new Date(Date.now() - PERIOD_MS[period]).toISOString() : null;
      const db = await getAdapter();
      stats = await getLatencyStats(db, since);
      cache.set(period, { ts: Date.now(), data: stats });
    }
    // m4: the card needs to know whether details are even recorded, so
    // its empty state can say so (same flag the Details tab already uses).
    const observabilityEnabled = await isObservabilityEnabled();
    return NextResponse.json({ period, ...stats, observabilityEnabled }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}
