import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/apiError";
import { installPxpipe } from "@/lib/pxpipe/install.js";
import { unloadPxpipe } from "@/lib/pxpipe/loader.js";
import { runHealthCheck } from "@/lib/pxpipe/service.js";

export const dynamic = "force-dynamic";
// npm install can legitimately take minutes on a cold cache.
export const maxDuration = 300;

// Install (or repair — same operation, reinstalls @latest) then re-run the health check.
export async function POST() {
  try {
    const info = await installPxpipe();
    unloadPxpipe(); // drop any previously-loaded version so health loads the fresh one
    const health = await runHealthCheck();
    return NextResponse.json({ ...info, health });
  } catch (error) {
    return apiErrorResponse(error, { code: error.code || "pxpipe_failed", message: "Failed to install pxpipe" });
  }
}
