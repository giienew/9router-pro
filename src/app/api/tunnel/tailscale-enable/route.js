import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/apiError";
import { enableTailscale } from "@/lib/tunnel";
import { getSettings } from "@/lib/localDb";
import { configureTunnelMonitoring } from "@/shared/services/initializeApp";

export async function POST() {
  try {
    const result = await enableTailscale();
    getSettings()
      .then(configureTunnelMonitoring)
      .catch((error) => console.warn("Tailscale monitor start failed:", error.message));
    return NextResponse.json(result);
  } catch (error) {
    console.error("Tailscale enable error:", error.message);
    return apiErrorResponse(error, { code: "tailscale_enable_failed", message: "Failed to enable Tailscale" });
  }
}
