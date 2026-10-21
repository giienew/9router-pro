import { NextResponse } from "next/server";
import { getApiKeys, createApiKey, getAllKeyQuotas, getKeyUsageInWindow, getAllKeyLimits } from "@/lib/localDb";
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
