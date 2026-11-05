import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/apiError";
import { getSettings } from "@/lib/localDb";
import { getPxpipeStatus } from "@/lib/pxpipe/service.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const settings = await getSettings();
    const status = getPxpipeStatus();
    return NextResponse.json({
      ...status,
      enabled: !!settings.pxpipeEnabled,
      autoInstall: !!settings.pxpipeAutoInstall,
      minChars: settings.pxpipeMinChars,
      timeoutMs: settings.pxpipeTimeoutMs,
    });
  } catch (error) {
    return apiErrorResponse(error, { code: "pxpipe_status_failed", message: "Failed to get pxpipe status" });
  }
}
