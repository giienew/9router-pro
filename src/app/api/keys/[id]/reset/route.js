import { NextResponse } from "next/server";
import { getApiKeyById, getKeyQuota, resetKeyQuota, getKeyUsageInWindow } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// POST /api/keys/:id/reset — move a key's quota baseline to now (manual
// reset, PATCH-ABCE). Usage history is kept; the counter restarts from
// resetAt, so quotaUsed comes back 0. Works for both rolling and
// absolute (lifetime) quotas.
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    const savedQuota = await resetKeyQuota(id);
    if (!savedQuota) {
      return NextResponse.json({ error: "Key has no quota to reset" }, { status: 400 });
    }
    const quotaUsed = await getKeyUsageInWindow(key.key, savedQuota.windowHours, savedQuota.resetAt, savedQuota.absolute);
    return NextResponse.json({ key: { ...key, quota: savedQuota, quotaUsed } });
  } catch (error) {
    console.log("Error resetting key quota:", error);
    return NextResponse.json({ error: "Failed to reset quota" }, { status: 500 });
  }
}
