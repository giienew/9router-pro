import { NextResponse } from "next/server";
import { getPromptInjectStats } from "@/lib/db/repos/promptInjectStatsRepo.js";

// Prompt Injection usage stats (9Router Pro) — read-only. Written by
// the chat hook in src/sse/handlers/chat.js, buffered like the Token
// Saver stats; this route only reads (and prunes rows older than 90
// days, the same retention the stats API itself enforces).
// GET /api/prompt-injection/stats?days=14 → { days, totals }
export async function GET(request) {
  try {
    const params = new URL(request.url).searchParams;
    let days = parseInt(params.get("days") || "14", 10);
    if (!Number.isFinite(days)) days = 14;
    days = Math.min(90, Math.max(1, days));
    return NextResponse.json(await getPromptInjectStats(days));
  } catch (error) {
    console.log("Error fetching prompt injection stats:", error);
    return NextResponse.json({ error: "Failed to fetch prompt injection stats" }, { status: 500 });
  }
}
