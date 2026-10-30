import { NextResponse } from "next/server";
import { getApiKeys, createApiKey, getApiKeyById, updateApiKey, getAllKeyQuotas, getKeyUsageInWindow, getAllKeyLimits, setKeyQuota, setKeyLimits } from "@/lib/localDb";
import { getAdapter } from "@/lib/db/driver.js";
import { recordQuotaPressure } from "@/lib/trustEvents.js";
import { getKeyLimitUsage } from "@/lib/keyRateLimiter.js";
import { getConsistentMachineId } from "@/shared/utils/machineId";

export const dynamic = "force-dynamic";

// GET /api/keys - List API keys (Pro: merges each key's token quota + usage)
export async function GET() {
  try {
    const keys = await getApiKeys();
    try {
      const quotas = await getAllKeyQuotas();
      const allLimits = await getAllKeyLimits();
      for (const key of keys) {
        const quota = quotas[key.id] || null;
        key.quota = quota;
        key.quotaUsed = quota ? await getKeyUsageInWindow(key.key, quota.windowHours) : 0;
        // R2 quota-pressure: deduped in recordQuotaPressure, and cleared
        // (re-arming) when usage drops below 90% — fire-and-forget.
        if (quota && Number(quota.limit) > 0) {
          getAdapter()
            .then((db) => recordQuotaPressure(db, key.name || key.id, key.quotaUsed, quota.limit, quota.unit || "tokens"))
            .catch(() => {});
        }
        const limits = allLimits[key.id] || null;
        key.limits = limits;
        key.limitsUsage = {
          ...getKeyLimitUsage(key.id),
          tpmUsed: limits?.tpm ? await getKeyUsageInWindow(key.key, 1 / 60) : 0,
        };
      }
    } catch {}
    return NextResponse.json({ keys });
  } catch (error) {
    console.log("Error fetching keys:", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key
export async function POST(request) {
  try {
    const body = await request.json();
    const { name } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    // Always get machineId from server
    const machineId = await getConsistentMachineId();
    const apiKey = await createApiKey(name, machineId);

    return NextResponse.json({
      key: apiKey.key,
      name: apiKey.name,
      id: apiKey.id,
      machineId: apiKey.machineId,
    }, { status: 201 });
  } catch (error) {
    console.log("Error creating key:", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}

// PATCH /api/keys — R11 bulk edit (backward-compatible: GET/POST and the
// single-key PUT in [id] are untouched). Body: { ids: [...], updates: {
// isActive?, expiresAt?, quota?, limits?, access? } }. Per-key results:
// successes in `updated`, failures in `failed` — one bad key never aborts
// the rest. `quota: null` / `limits: null` clear, mirroring single-key PUT.
export async function PATCH(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === "string") : [];
    const updates = body.updates && typeof body.updates === "object" ? body.updates : null;
    if (!ids.length || !updates) {
      return NextResponse.json({ error: "ids[] and updates are required" }, { status: 400 });
    }
    if (updates.expiresAt !== undefined && updates.expiresAt !== null && !Number.isFinite(new Date(updates.expiresAt).getTime())) {
      return NextResponse.json({ error: "expiresAt must be an ISO date or null" }, { status: 400 });
    }
    const updated = [];
    const failed = [];
    for (const id of ids) {
      try {
        const existing = await getApiKeyById(id);
        if (!existing) { failed.push({ id, error: "Key not found" }); continue; }
        const updateData = {};
        if (updates.isActive !== undefined) updateData.isActive = updates.isActive;
        if (updates.expiresAt !== undefined) updateData.expiresAt = updates.expiresAt;
        if (updates.access !== undefined) {
          const { validateKeyAccessInput } = await import("@/shared/utils/keyAccess.js");
          const checked = validateKeyAccessInput(updates.access);
          if (!checked.ok) { failed.push({ id, error: checked.error }); continue; }
          updateData.access = checked.value;
        }
        await updateApiKey(id, updateData);
        if (updates.quota !== undefined) await setKeyQuota(id, updates.quota);
        if (updates.limits !== undefined) await setKeyLimits(id, updates.limits);
        updated.push(id);
      } catch (e) {
        failed.push({ id, error: e?.message || "failed" });
      }
    }
    return NextResponse.json({ updated, failed });
  } catch (error) {
    console.log("Error bulk-updating keys:", error);
    return NextResponse.json({ error: "Failed to bulk-update keys" }, { status: 500 });
  }
}
