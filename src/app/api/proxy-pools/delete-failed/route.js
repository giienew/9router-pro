import { NextResponse } from "next/server";
import { deleteProxyPoolsByIds, getProxyPools } from "@/lib/db/repos/proxyPoolsRepo";
import { getBoundProxyPoolIds } from "@/lib/db/repos/connectionsRepo";
import { checkDashboardThrottle, dashboardThrottleResponse, DASHBOARD_THROTTLE_MAX_MUTATE } from "@/lib/auth/dashboardThrottle";

// POST /api/proxy-pools/delete-failed — delete every pool whose last test
// failed (testStatus "error"). Pools still bound to a connection are skipped,
// mirroring the single-pool delete rule.
export async function POST(request) {
  const throttle = checkDashboardThrottle(request, "proxy-pools/delete-failed", DASHBOARD_THROTTLE_MAX_MUTATE);
  if (!throttle.allowed) return dashboardThrottleResponse(throttle.retryAfterSec);
  const failed = await getProxyPools({ testStatus: "error" });
  if (!failed.length) {
    return NextResponse.json({ deleted: 0, skippedBound: 0 });
  }
  const bound = new Set(await getBoundProxyPoolIds());
  const deletable = failed.filter((p) => !bound.has(p.id)).map((p) => p.id);
  const deleted = await deleteProxyPoolsByIds(deletable);
  return NextResponse.json({ deleted, skippedBound: failed.length - deletable.length });
}
