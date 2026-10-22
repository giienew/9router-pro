import { NextResponse } from "next/server";
import { getUsageStats } from "@/lib/usageDb";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all", "custom"]);
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Short-lived cache: the dashboard polls this on every period switch and
// mount, and a full stats build scans rollups + history. 5s is invisible
// to the user (SSE covers realtime) and absorbs duplicate calls.
const CACHE_TTL_MS = 5000;
const cache = new Map();

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    let range = null;
    if (period === "custom") {
      const start = searchParams.get("start") || "";
      const end = searchParams.get("end") || "";
      if (!DATE_KEY_RE.test(start) || !DATE_KEY_RE.test(end) || start > end) {
        return NextResponse.json({ error: "Custom period needs start and end dates (YYYY-MM-DD, start <= end)" }, { status: 400 });
      }
      range = { startKey: start, endKey: end };
    }

    const cacheKey = `${period}|${range?.startKey || ""}|${range?.endKey || ""}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
      return NextResponse.json(hit.data);
    }

    const stats = await getUsageStats(period, range);
    cache.set(cacheKey, { ts: Date.now(), data: stats });
    return NextResponse.json(stats);
  } catch (error) {
    console.error("[API] Failed to get usage stats:", error);
    return NextResponse.json({ error: "Failed to fetch usage stats" }, { status: 500 });
  }
}
