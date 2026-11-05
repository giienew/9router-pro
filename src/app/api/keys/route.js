import { NextResponse } from "next/server";
import { getApiKeys, createApiKey, getApiKeyById, updateApiKey, getApiKeyByKey, getAllKeyQuotas, getKeyUsageInWindow, getAllKeyLimits, getKeyQuota, getKeyLimits, setKeyQuota, setKeyLimits } from "@/lib/localDb";
import { getAdapter } from "@/lib/db/driver.js";
import { recordQuotaPressure } from "@/lib/trustEvents.js";
import { getKeyLimitUsage } from "@/lib/keyRateLimiter.js";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { validateCustomKey } from "@/shared/utils/apiKey";
import { MAX_BULK_IMPORT_ITEMS } from "@/lib/oauth/bulkImport";

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
    const { name, prefix, customKey } = body;

    if (!name || !String(name).trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    const trimmedName = String(name).trim();

    // opt10: key names are unique (case-insensitive) — two keys sharing a
    // name are indistinguishable in the list, which misleads resellers.
    const existingKeys = await getApiKeys();
    if (existingKeys.some((k) => (k.name || "").trim().toLowerCase() === trimmedName.toLowerCase())) {
      return NextResponse.json({ error: "Nama key sudah dipakai" }, { status: 400 });
    }

    // opt10: an optional custom value IS the full key (prefix is ignored
    // entirely — not validated, not prepended). Empty means "generate".
    const rawCustom = typeof customKey === "string" ? customKey.trim() : "";
    let customValue = null;
    if (rawCustom !== "") {
      const checked = validateCustomKey(rawCustom);
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
      if (await getApiKeyByKey(checked.value)) {
        return NextResponse.json({ error: "Key sudah dipakai" }, { status: 400 });
      }
      customValue = checked.value;
    }

    // Custom key prefix (per key, at creation). Default stays "sk".
    // Skipped entirely when a custom value is given.
    const rawPrefix = typeof prefix === "string" ? prefix.trim() : "";
    const keyPrefix = rawPrefix === "" ? "sk" : rawPrefix;
    if (!customValue && !/^[A-Za-z0-9_-]{1,20}$/.test(keyPrefix)) {
      return NextResponse.json({ error: "Invalid prefix: only letters, digits, - and _ allowed, max 20 chars" }, { status: 400 });
    }

    // Always get machineId from server
    const machineId = await getConsistentMachineId();
    const apiKey = await createApiKey(trimmedName, machineId, customValue ? { customKey: customValue } : { prefix: keyPrefix });

    return NextResponse.json({
      key: apiKey.key,
      name: apiKey.name,
      id: apiKey.id,
      machineId: apiKey.machineId,
    }, { status: 201 });
  } catch (error) {
    console.log("Error creating key:", error);
    // opt13 M-I7: race backstop for the DB unique indexes — a duplicate
    // that slipped past the app checks must 400, not 500.
    const msg = String(error?.message || "");
    if (/UNIQUE constraint failed/.test(msg)) {
      if (/idx_apiKeys_name_unique|apiKeys\.name/.test(msg)) return NextResponse.json({ error: "Nama key sudah dipakai" }, { status: 400 });
      if (/idx_apiKeys_key_unique|apiKeys\.key/.test(msg)) return NextResponse.json({ error: "Key sudah dipakai" }, { status: 400 });
      return NextResponse.json({ error: "Nama atau key sudah dipakai" }, { status: 400 });
    }
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
    // M-1: cap the batch like the bulk imports (50/request). Each id is
    // several DB reads/writes, so an uncapped batch holds the server in a
    // long sequential loop.
    if (ids.length > MAX_BULK_IMPORT_ITEMS) {
      return NextResponse.json(
        { error: `Bulk edit is limited to ${MAX_BULK_IMPORT_ITEMS} keys per request` },
        { status: 400 }
      );
    }
    if (updates.expiresAt !== undefined && updates.expiresAt !== null && !Number.isFinite(new Date(updates.expiresAt).getTime())) {
      return NextResponse.json({ error: "expiresAt must be an ISO date or null" }, { status: 400 });
    }
    // opt13 M1: partial bulk payloads must MERGE with stored values, not
    // replace them (a bulk TPM-only edit previously wiped rpm/rph and the
    // spend cap). Validate numbers upfront: 0/garbage must 400, never null
    // a whole config. Explicit null still clears (whole object or a field).
    const isPosNum = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0) || (typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()) && Number(v) > 0);
    if (updates.quota !== undefined && updates.quota !== null && typeof updates.quota !== "object") {
      return NextResponse.json({ error: "Bulk quota must be an object" }, { status: 400 });
    }
    if (updates.limits !== undefined && updates.limits !== null && typeof updates.limits !== "object") {
      return NextResponse.json({ error: "Bulk limits must be an object" }, { status: 400 });
    }
    if (updates.quota && typeof updates.quota === "object") {
      if (updates.quota.limit !== undefined && updates.quota.limit !== null && !isPosNum(updates.quota.limit)) {
        return NextResponse.json({ error: "Bulk quota limit must be a positive number" }, { status: 400 });
      }
      if (updates.quota.costLimit !== undefined && updates.quota.costLimit !== null && !isPosNum(updates.quota.costLimit)) {
        return NextResponse.json({ error: "Bulk quota Max spend must be a positive number" }, { status: 400 });
      }
      if (updates.quota.windowHours !== undefined && updates.quota.windowHours !== null && !Number.isFinite(Number(updates.quota.windowHours))) {
        return NextResponse.json({ error: "Bulk quota window must be a number" }, { status: 400 });
      }
    }
    if (updates.limits && typeof updates.limits === "object") {
      for (const [f, v] of Object.entries(updates.limits)) {
        if (v !== null && !isPosNum(v)) {
          return NextResponse.json({ error: `Bulk limit ${f} must be a positive number` }, { status: 400 });
        }
      }
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
        if (updates.quota !== undefined) {
          if (updates.quota === null) await setKeyQuota(id, null);
          else await setKeyQuota(id, { ...(await getKeyQuota(id) || {}), ...updates.quota });
        }
        if (updates.limits !== undefined) {
          if (updates.limits === null) await setKeyLimits(id, null);
          else await setKeyLimits(id, { ...(await getKeyLimits(id) || {}), ...updates.limits });
        }
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
