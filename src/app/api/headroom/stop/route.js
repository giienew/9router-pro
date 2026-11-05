import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/apiError";
import { stopHeadroomProxy } from "@/lib/headroom/process";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = stopHeadroomProxy();
    const status = result.stopped ? 200 : 409;
    return NextResponse.json({ ...result }, { status });
  } catch (error) {
    return apiErrorResponse(error, { code: error.code || "headroom_failed", message: "Failed to stop headroom proxy" });
  }
}
