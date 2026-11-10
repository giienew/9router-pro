import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById, getApiKeyByKey, getApiKeys, updateApiKey, getKeyQuota, setKeyQuota, deleteKeyQuota, getKeyUsageInWindow, getKeyLimits, setKeyLimits, deleteKeyLimits } from "@/lib/localDb";
import { getKeyLimitUsage } from "@/lib/keyRateLimiter.js";
import { validateKeyAccessInput } from "@/shared/utils/keyAccess.js";
import { generateApiKeyWithMachine, prefixOfStandardKey, validateCustomKey } from "@/shared/utils/apiKey";
import { getConsistentMachineId } from "@/shared/utils/machineId";

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    // Live usage for the dashboard: the same snapshot PUT returns, so the
    // "Live:" line in the key panel reflects current traffic instead of
    // the page-load values from the list GET.
    const savedLimits = await getKeyLimits(id);
    key.limitsUsage = {
      ...getKeyLimitUsage(id),
      tpmUsed: savedLimits?.tpm ? await getKeyUsageInWindow(key.key, 1 / 60) : 0,
    };
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
    const { isActive, access, quota, limits, expiresAt, name, regenerate, customKey } = body;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const updateData = {};
    // opt10: only fields actually present are touched — undefined leaves the
    // stored value alone, so the older access/quota/limits/expiry/isActive
    // callers keep working byte-for-byte as before.
    // Rename: trimmed, non-empty, unique (case-insensitive) among OTHER keys,
    // so re-saving a key's own name never false-positives.
    if (name !== undefined) {
      const trimmedName = typeof name === "string" ? name.trim() : "";
      if (!trimmedName) {
        return NextResponse.json({ error: "Nama key tidak boleh kosong" }, { status: 400 });
      }
      const others = await getApiKeys();
      if (others.some((k) => k.id !== id && (k.name || "").trim().toLowerCase() === trimmedName.toLowerCase())) {
        return NextResponse.json({ error: "Nama key sudah dipakai" }, { status: 400 });
      }
      updateData.name = trimmedName;
    }
    // Key-value change: regenerate OR custom, never both and never silently
    // picked — a caller sending both gets an explicit 400.
    const rawCustom = typeof customKey === "string" ? customKey.trim() : "";
    if (regenerate === true && rawCustom !== "") {
      return NextResponse.json({ error: "Pilih salah satu: regenerate atau custom key" }, { status: 400 });
    }
    if (regenerate === true) {
      // Standard random value; the existing prefix survives, a custom value
      // regenerates to sk-standard (it has no prefix to keep).
      const machineId = existing.machineId || (await getConsistentMachineId());
      const prefix = prefixOfStandardKey(existing.key) || "sk";
      let generated = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = generateApiKeyWithMachine(machineId, prefix);
        if (!(await getApiKeyByKey(candidate.key))) { generated = candidate; break; }
      }
      if (!generated) {
        return NextResponse.json({ error: "Gagal regenerate key, coba lagi" }, { status: 500 });
      }
      updateData.key = generated.key;
    } else if (rawCustom !== "") {
      const checked = validateCustomKey(rawCustom);
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
      const clash = await getApiKeyByKey(checked.value);
      if (clash && clash.id !== id) {
        return NextResponse.json({ error: "Key sudah dipakai" }, { status: 400 });
      }
      updateData.key = checked.value;
    }
    if (isActive !== undefined) updateData.isActive = isActive;
    if (expiresAt !== undefined) {
      if (expiresAt !== null && !Number.isFinite(new Date(expiresAt).getTime())) {
        return NextResponse.json({ error: "expiresAt must be an ISO date or null" }, { status: 400 });
      }
      updateData.expiresAt = expiresAt;
    }
    if (access !== undefined) {
      const checked = validateKeyAccessInput(access);
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
      updateData.access = checked.value;
    }

    const updated = await updateApiKey(id, updateData);

    // Pro: token quota lives in KV, keyed by key id. `quota: null` clears it.
    // opt46 (M1-key): merge with the stored quota first, like bulk PATCH —
    // the old replace dropped fields the caller did not send (costLimit).
    let savedQuota = await getKeyQuota(id);
    if (quota !== undefined) {
      savedQuota = quota === null
        ? await setKeyQuota(id, null)
        : await setKeyQuota(id, { ...(savedQuota || {}), ...quota });
    }
    updated.quota = savedQuota;
    // Usage is keyed by key string: after a value change the NEW key counts,
    // so the response never reports the dead key's usage as the live one's.
    updated.quotaUsed = savedQuota ? await getKeyUsageInWindow(updated.key, savedQuota.windowHours) : 0;

    // Pro: rate limits live in KV too. `limits: null` clears them.
    // opt46 (M1-key): same stored-first merge as bulk PATCH.
    let savedLimits = await getKeyLimits(id);
    if (limits !== undefined) {
      savedLimits = limits === null
        ? await setKeyLimits(id, null)
        : await setKeyLimits(id, { ...(savedLimits || {}), ...limits });
    }
    updated.limits = savedLimits;
    updated.limitsUsage = {
      ...getKeyLimitUsage(id),
      tpmUsed: savedLimits?.tpm ? await getKeyUsageInWindow(updated.key, 1 / 60) : 0,
    };

    return NextResponse.json({ key: updated });
  } catch (error) {
    console.log("Error updating key:", error);
    // opt13 M-I7: same race backstop as POST — DB unique violations 400.
    const msg = String(error?.message || "");
    if (/UNIQUE constraint failed/.test(msg)) {
      if (/idx_apiKeys_name_unique|apiKeys\.name/.test(msg)) return NextResponse.json({ error: "Nama key sudah dipakai" }, { status: 400 });
      if (/idx_apiKeys_key_unique|apiKeys\.key/.test(msg)) return NextResponse.json({ error: "Key sudah dipakai" }, { status: 400 });
      return NextResponse.json({ error: "Nama atau key sudah dipakai" }, { status: 400 });
    }
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
