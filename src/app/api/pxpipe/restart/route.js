import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/apiError";
import { unloadPxpipe, loadPxpipe } from "@/lib/pxpipe/loader.js";
import { getPxpipeStatus } from "@/lib/pxpipe/service.js";

export const dynamic = "force-dynamic";

// Reload the in-process module (picks up an upgraded install without a server restart).
export async function POST() {
  try {
    unloadPxpipe();
    await loadPxpipe();
    return NextResponse.json(getPxpipeStatus());
  } catch (error) {
    return apiErrorResponse(error, { code: error.code || "pxpipe_failed", message: "Failed to restart pxpipe" });
  }
}
