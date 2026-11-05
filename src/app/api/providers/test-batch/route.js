import { NextResponse } from "next/server";
import { getProviderConnections } from "@/models";
import {
  FREE_PROVIDERS,
  OAUTH_PROVIDERS,
  APIKEY_PROVIDERS,
  OPENAI_COMPATIBLE_PREFIX,
  ANTHROPIC_COMPATIBLE_PREFIX,
} from "@/shared/constants/providers";
import { testSingleConnection } from "../[id]/test/testUtils.js";
import {
  registerBatchJob,
  isBatchStopped,
  clearBatchJob,
} from "@/lib/batchTestRegistry";
import { invalidateStatsCache } from "@/lib/providerStatsCache";
import { checkDashboardThrottle, dashboardThrottleResponse, DASHBOARD_THROTTLE_MAX_TEST } from "@/lib/auth/dashboardThrottle";

function getAuthGroup(providerId, connection = null) {
  // Prioritize authType from connection if available
  if (connection?.authType) {
    if (connection.authType === "oauth") {
      // Check if it's a free provider
      if (FREE_PROVIDERS[providerId]) return "free";
      return "oauth";
    }
    return connection.authType;
  }
  
  // Fallback to constants
  if (FREE_PROVIDERS[providerId]) return "free";
  if (OAUTH_PROVIDERS[providerId]) return "oauth";
  if (APIKEY_PROVIDERS[providerId]) return "apikey";
  if (
    typeof providerId === "string" &&
    (providerId.startsWith(OPENAI_COMPATIBLE_PREFIX) || providerId.startsWith(ANTHROPIC_COMPATIBLE_PREFIX))
  )
    return "compatible";
  return "apikey";
}

function isCompatibleProvider(providerId) {
  return (
    typeof providerId === "string" &&
    (providerId.startsWith(OPENAI_COMPATIBLE_PREFIX) || providerId.startsWith(ANTHROPIC_COMPATIBLE_PREFIX))
  );
}

// POST /api/providers/test-batch - Test multiple connections by group
export async function POST(request) {
  const throttle = checkDashboardThrottle(request, "providers/test-batch", DASHBOARD_THROTTLE_MAX_TEST);
  if (!throttle.allowed) return dashboardThrottleResponse(throttle.retryAfterSec);
  let jobId = null;
  try {
    const body = await request.json();
    const { mode, providerId } = body;
    jobId = typeof body.jobId === "string" ? body.jobId : null;

    if (!mode) {
      return NextResponse.json({ error: "mode is required" }, { status: 400 });
    }

    const allConnections = await getProviderConnections({ isActive: true });

    let connectionsToTest = [];
    if (mode === "provider" && providerId) {
      connectionsToTest = allConnections.filter((c) => c.provider === providerId);
    } else if (mode === "oauth") {
      connectionsToTest = allConnections.filter((c) => getAuthGroup(c.provider, c) === "oauth");
    } else if (mode === "free") {
      connectionsToTest = allConnections.filter((c) => getAuthGroup(c.provider, c) === "free");
    } else if (mode === "apikey") {
      connectionsToTest = allConnections.filter((c) => getAuthGroup(c.provider, c) === "apikey");
    } else if (mode === "compatible") {
      connectionsToTest = allConnections.filter((c) => isCompatibleProvider(c.provider));
    } else if (mode === "all") {
      connectionsToTest = allConnections;
    } else {
      return NextResponse.json(
        { error: "Invalid mode. Use: provider, oauth, free, apikey, compatible, all" },
        { status: 400 }
      );
    }

    if (connectionsToTest.length === 0) {
      return NextResponse.json({
        mode,
        providerId: providerId || null,
        results: [],
        summary: { total: 0, passed: 0, failed: 0 },
        testedAt: new Date().toISOString(),
      });
    }

    if (jobId) registerBatchJob(jobId);
    let stopped = false;
    const results = [];
    let passed = 0;
    let failed = 0;
    let tested = 0;
    for (const conn of connectionsToTest) {
      // Stop asked via /test-batch/stop, or the client went away entirely.
      if ((jobId && isBatchStopped(jobId)) || request.signal?.aborted) {
        stopped = true;
        break;
      }
      try {
        const data = await testSingleConnection(conn.id);
        tested++;
        if (data.valid) {
          passed++;
        } else {
          failed++;
          results.push({
            provider: conn.provider,
            connectionId: conn.id,
            connectionName: conn.name || conn.email || conn.provider,
            authType: conn.authType || getAuthGroup(conn.provider, conn),
            valid: false,
            latencyMs: data.latencyMs || 0,
            error: data.error || null,
            diagnosis: data.diagnosis || null,
            statusCode: data.statusCode || null,
            testedAt: data.testedAt || new Date().toISOString(),
          });
        }
      } catch (error) {
        tested++;
        failed++;
        results.push({
          provider: conn.provider,
          connectionId: conn.id,
          connectionName: conn.name || conn.email || conn.provider,
          authType: conn.authType || getAuthGroup(conn.provider, conn),
          valid: false,
          latencyMs: 0,
          error: error.message,
          diagnosis: { type: "network_error", source: "local", code: null, message: error.message },
          statusCode: null,
          testedAt: new Date().toISOString(),
        });
      }
    }

    if (jobId) clearBatchJob(jobId);
    // Tests mutate testStatus/lastTested, so the summary cache must not
    // keep serving pre-test counts.
    invalidateStatsCache();
    return NextResponse.json({
      mode,
      providerId: providerId || null,
      // Failures only: a full-fleet run returns tens of thousands of success
      // rows the UI never needs. The summary still reflects the full run.
      results,
      failuresOnly: true,
      stopped,
      testedAt: new Date().toISOString(),
      summary: {
        total: tested,
        planned: connectionsToTest.length,
        passed,
        failed,
      },
    });
  } catch (error) {
    if (jobId) clearBatchJob(jobId);
    console.log("Error in batch test:", error);
    return NextResponse.json({ error: "Batch test failed" }, { status: 500 });
  }
}
