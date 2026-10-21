import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById, updateApiKey, getKeyQuota, setKeyQuota, deleteKeyQuota, getKeyUsageInWindow, getKeyLimits, setKeyLimits, deleteKeyLimits } from "@/lib/localDb";
import { getKeyLimitUsage } from "@/lib/keyRateLimiter.js";
import { validateKeyAccessInput } from "@/shared/utils/keyAccess.js";

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key (Pro: also accepts `quota` and `limits`)
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { isActive, access, quota, limits } = body;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const updateData = {};
    if (isActive !== undefined) updateData.isActive = isActive;
    if (access !== undefined) {
      const checked = validateKeyAccessInput(access);
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
      updateData.access = checked.value;
    }

    const updated = await updateApiKey(id, updateData);

    // Pro: token quota lives in KV, keyed by key id. `quota: null` clears it.
    let savedQuota = await getKeyQuota(id);
    if (quota !== undefined) {
      savedQuota = await setKeyQuota(id, quota);
    }
    updated.quota = savedQuota;
    updated.quotaUsed = savedQuota ? await getKeyUsageInWindow(existing.key, savedQuota.windowHours) : 0;

    // Pro: rate limits live in KV too. `limits: null` clears them.
    let savedLimits = await getKeyLimits(id);
    if (limits !== undefined) {
      savedLimits = await setKeyLimits(id, limits);
    }
    updated.limits = savedLimits;
    updated.limitsUsage = {
      ...getKeyLimitUsage(id),
      tpmUsed: savedLimits?.tpm ? await getKeyUsageInWindow(existing.key, 1 / 60) : 0,
    };

    return NextResponse.json({ key: updated });
  } catch (error) {
    console.log("Error updating key:", error);
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
}

// DELETE /api/keys/[id] - Delete API key
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    await deleteKeyQuota(id).catch(() => {});
    await deleteKeyLimits(id).catch(() => {});

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}
