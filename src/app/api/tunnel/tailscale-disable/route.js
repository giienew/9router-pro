import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/apiError";
import { disableTailscale } from "@/lib/tunnel";
import { getSettings } from "@/lib/localDb";
import { configureTunnelMonitoring } from "@/shared/services/initializeApp";

export async function POST() {
  try {
    const result = await disableTailscale();
    getSettings()
      .then(configureTunnelMonitoring)
      .catch((error) => console.warn("Tailscale monitor update failed:", error.message));
    return NextResponse.json(result);
  } catch (error) {
    console.error("Tailscale disable error:", error);
    return apiErrorResponse(error, { code: "tailscale_disable_failed", message: "Failed to disable Tailscale" });
  }
}
