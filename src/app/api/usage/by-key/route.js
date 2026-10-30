import { NextResponse } from "next/server";
import { isAuthenticated } from "@/dashboardGuard";
import { getApiKeyById } from "@/lib/localDb";
import { getKeyUsageBreakdown } from "@/lib/db/repos/usageRepo.js";
import { maskApiKeyForWebhook } from "@/lib/webhookEvents.js";

export const dynamic = "force-dynamic";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all", "custom"]);
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_MS = { "24h": 86400000, "7d": 604800000, "30d": 2592000000, "60d": 5184000000 };

// GET /api/usage/by-key — per-key usage breakdown for the dashboard (G14).
// Dashboard-authenticated: the dashboard proxy gates this path, and this
// route additionally requires a valid dashboard session (isAuthenticated
// also passes when the dashboard is configured open with requireLogin
// false, matching dashboard behavior elsewhere).
//
// Query: ?keyId=<apiKeys.id> (optional; omit for all keys),
//   ?period=today|24h|7d|30d|60d|all|custom (default 7d),
//   ?start=YYYY-MM-DD&?end=YYYY-MM-DD (custom only, end inclusive).
//
// Filtering is by key ID, never by raw key value: the id resolves to the
// stored key server-side, and the response carries only the key id, the
// key name, and a masked key (first 8 + *** + last 4). The raw key value
// is never echoed, never appears in the URL, and never leaves the server.
export async function GET(request) {
  try {
    if (!(await isAuthenticated(request))) {
      return NextResponse.json({ error: "Dashboard authentication required" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";
    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    let startDate = null;
    let endDate = null;
    if (period === "custom") {
      const start = searchParams.get("start") || "";
      const end = searchParams.get("end") || "";
      if (!DATE_KEY_RE.test(start) || !DATE_KEY_RE.test(end) || start > end) {
        return NextResponse.json({ error: "Custom period needs start and end dates (YYYY-MM-DD, start <= end)" }, { status: 400 });
      }
      startDate = new Date(`${start}T00:00:00.000Z`);
      endDate = new Date(`${end}T23:59:59.999Z`);
    } else if (period === "today") {
      startDate = new Date();
      startDate.setUTCHours(0, 0, 0, 0);
    } else if (period !== "all") {
      startDate = new Date(Date.now() - PERIOD_MS[period]);
    }

    let key = null;
    let rawKey = null;
    const keyId = searchParams.get("keyId");
    if (keyId) {
      const record = await getApiKeyById(keyId);
      if (!record) {
        return NextResponse.json({ error: "Unknown keyId" }, { status: 404 });
      }
      key = { id: record.id, name: record.name || null, apiKeyMasked: maskApiKeyForWebhook(record.key) };
      rawKey = record.key;
    }

    const { totals, byModel, byProvider, byEndpoint } = await getKeyUsageBreakdown({
      rawKey, startDate, endDate,
    });

    return NextResponse.json({
      period,
      ...(startDate ? { start: startDate.toISOString() } : {}),
      ...(endDate ? { end: endDate.toISOString() } : {}),
      key,
      totals,
      byModel,
      byProvider,
      byEndpoint,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[API] Failed to get per-key usage breakdown:", error);
    return NextResponse.json({ error: "Failed to fetch per-key usage breakdown" }, { status: 500 });
  }
}
