import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/apiError";
import { getPxpipeStats } from "@/lib/pxpipe/events.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const recentLimit = Math.min(Number(searchParams.get("limit")) || 100, 500);
    return NextResponse.json(getPxpipeStats({ recentLimit }));
  } catch (error) {
    return apiErrorResponse(error, { code: "pxpipe_stats_failed", message: "Failed to load pxpipe stats" });
  }
}
