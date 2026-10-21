import { NextResponse } from "next/server";
import { getTokenSaverStats } from "@/lib/localDb";

// GET /api/token-saver/stats?days=14 — RTK savings aggregates for the
// Token Saver dashboard panel (9Router Pro).
export async function GET(request) {
  try {
    const days = Math.min(90, Math.max(1, Number(new URL(request.url).searchParams.get("days")) || 14));
    return NextResponse.json(await getTokenSaverStats(days));
  } catch (error) {
    console.log("Error fetching token saver stats:", error);
    return NextResponse.json({ error: "Failed to fetch stats" }, { status: 500 });
  }
}
