import { NextResponse } from "next/server";
import { extractClientApiKey } from "@/sse/services/keyAccess.js";
import { getApiKeyByKey, isKeyExpired } from "@/lib/localDb";
import { getKeyUsagePage } from "@/lib/db/repos/usageRepo.js";

// GET /api/v1/usage — scoped usage view (P3-26). Authenticated by the
// caller's own API key (edge proxy already validates it via
// validateApiKey, which now includes expiry); the response contains ONLY
// rows burned by that key, newest first, paginated. The key value itself
// is never echoed. Query: ?limit (1..200, default 50) & ?offset.
export async function GET(request) {
  try {
    const rawKey = extractClientApiKey(request);
    if (!rawKey) {
      return NextResponse.json({ error: "API key required" }, { status: 401 });
    }
    const record = await getApiKeyByKey(rawKey);
    if (!record || record.isActive === false || isKeyExpired(record.expiresAt)) {
      return NextResponse.json({ error: "Invalid or expired API key" }, { status: 401 });
    }
    const url = new URL(request.url);
    const page = await getKeyUsagePage(rawKey, {
      limit: url.searchParams.get("limit"),
      offset: url.searchParams.get("offset"),
    });
    return NextResponse.json({ key: record.name || record.id, ...page });
  } catch (error) {
    console.log("Error fetching scoped usage:", error);
    return NextResponse.json({ error: "Failed to fetch usage" }, { status: 500 });
  }
}
