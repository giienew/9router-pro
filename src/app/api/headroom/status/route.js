import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/apiError";
import { getSettings } from "@/lib/localDb";
import { DEFAULT_HEADROOM_URL, getHeadroomStatus } from "@/lib/headroom/detect";
import { getManagedPid } from "@/lib/headroom/process";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const settings = await getSettings();
    const url = settings.headroomUrl || DEFAULT_HEADROOM_URL;
    const status = await getHeadroomStatus(url);
    const managedPid = getManagedPid();
    return NextResponse.json({ ...status, url, managedPid });
  } catch (error) {
    return apiErrorResponse(error, { code: "headroom_status_failed", message: "Failed to get headroom status" });
  }
}
