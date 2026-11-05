import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/apiError";
import { unloadPxpipe } from "@/lib/pxpipe/loader.js";
import { getPxpipeStatus } from "@/lib/pxpipe/service.js";

export const dynamic = "force-dynamic";

// "Stop" in library mode = drop the in-process module; requests fail open to
// uncompressed passthrough until it is started again.
export async function POST() {
  try {
    const wasLoaded = unloadPxpipe();
    return NextResponse.json({ stopped: wasLoaded, ...getPxpipeStatus() });
  } catch (error) {
    return apiErrorResponse(error, { code: "pxpipe_stop_failed", message: "Failed to stop pxpipe" });
  }
}
