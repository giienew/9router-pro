import { NextResponse } from "next/server";
import { testSingleConnection } from "./testUtils.js";
import { invalidateStatsCache } from "@/lib/providerStatsCache";

// POST /api/providers/[id]/test - Test connection
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const result = await testSingleConnection(id);

    // A single test mutates testStatus/lastTested, so the summary cache
    // must not keep serving pre-test counts (same as test-batch).
    invalidateStatsCache();

    if (result.error === "Connection not found") {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    return NextResponse.json({
      valid: result.valid,
      error: result.error,
      stage: result.stage || null,
      refreshed: result.refreshed || false,
    });
  } catch (error) {
    console.log("Error testing connection:", error);
    return NextResponse.json({ error: "Test failed" }, { status: 500 });
  }
}
