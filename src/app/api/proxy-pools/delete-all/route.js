import { NextResponse } from "next/server";
import { deleteAllProxyPools } from "@/lib/db/repos/proxyPoolsRepo";
import { checkDashboardThrottle, dashboardThrottleResponse, DASHBOARD_THROTTLE_MAX_MUTATE } from "@/lib/auth/dashboardThrottle";

// POST /api/proxy-pools/delete-all — delete EVERY proxy pool and unpin every
// connection bound to a pool (back to DIRECT). Unlike delete-failed, bound
// pools are NOT skipped: unpinning is the point. The response states how
// many pools were deleted and how many connections were unpinned.
export async function POST(request) {
  const throttle = checkDashboardThrottle(request, "proxy-pools/delete-all", DASHBOARD_THROTTLE_MAX_MUTATE);
  if (!throttle.allowed) return dashboardThrottleResponse(throttle.retryAfterSec);
  const { deletedPools, unpinnedConnections } = await deleteAllProxyPools();
  return NextResponse.json({ deletedPools, unpinnedConnections });
}
