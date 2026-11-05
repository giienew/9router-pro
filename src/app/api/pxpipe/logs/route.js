import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/apiError";
import { getInstallLogTail } from "@/lib/pxpipe/install.js";
import { readPxpipeEvents } from "@/lib/pxpipe/events.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(Number(searchParams.get("limit")) || 100, 500);
    return NextResponse.json({
      installLog: getInstallLogTail(),
      events: readPxpipeEvents({ limit }).reverse(),
    });
  } catch (error) {
    return apiErrorResponse(error, { code: "pxpipe_logs_failed", message: "Failed to load pxpipe logs" });
  }
}
