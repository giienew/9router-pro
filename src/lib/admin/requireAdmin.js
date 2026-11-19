// Shared gate for the Admin API routes (9Router Pro, pro.29).
// Strict dashboard-session check — the same bar as /api/security-log:
// a valid `auth_token` cookie is required. An API key alone never opens
// these routes, and requireLogin=false does not bypass them either,
// because the actions here (restart, breaker reset, session revoke) are
// destructive. The dashboardGuard middleware already blocks /api/*
// without auth; this is the explicit second check so the route returns
// 401 on its own terms and stays testable.
import { cookies } from "next/headers";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession.js";
import { getAdapter } from "@/lib/db/driver.js";
import { recordSecurityEvent } from "@/lib/trustEvents.js";

export async function requireDashboardAuth() {
  const store = await cookies();
  const token = store.get("auth_token")?.value || null;
  return verifyDashboardAuthToken(token);
}

// Every Admin maintenance action writes one security-log row so the
// action is auditable in the Admin Logs section. Best-effort: logging
// must never fail the action itself.
export async function logAdminEvent(event, detail) {
  try {
    const db = await getAdapter();
    recordSecurityEvent(db, { event, detail });
  } catch {}
}
