import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getProviderConnections } from "@/lib/localDb";
import { getProviderBreakerSnapshot } from "@/sse/services/providerBreaker.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// GET /api/health — liveness plus health detail (G11).
// M-2: the status code carries the verdict. When the instance is degraded
// (DB unreachable or any breaker open/half-open) the response is HTTP 503
// with `ok: false`, so a monitor that only reads the status code or `ok`
// can no longer miss a DB outage or a tripped provider breaker. Healthy
// stays HTTP 200 with `ok: true`. `degraded` and `checks` keep their
// shapes so existing body readers keep working.
//
// checks shape:
//   checks.db: "ok" | "error" (a SELECT 1 against the app database)
//   checks.connections: { total, active } (stored provider connections)
//   checks.breakers: { total, open, halfOpen, preTrip }
//     preTrip counts closed breakers with failures in the window —
//     the same pre-trip definition as /api/providers?summary=1.
export async function GET() {
  let db = "ok";
  try {
    const adapter = await getAdapter();
    adapter.get("SELECT 1 AS one");
  } catch {
    db = "error";
  }

  let connections = { total: 0, active: 0 };
  try {
    const rows = await getProviderConnections();
    connections = {
      total: rows.length,
      active: rows.filter((c) => c.isActive !== false).length,
    };
  } catch {
    // A connection-list failure is itself a DB problem; db already says so.
    connections = { total: 0, active: 0 };
  }

  const snapshot = getProviderBreakerSnapshot();
  const breakers = { total: 0, open: 0, halfOpen: 0, preTrip: 0 };
  for (const b of Object.values(snapshot)) {
    breakers.total += 1;
    if (b.state === "open") breakers.open += 1;
    else if (b.state === "half-open") breakers.halfOpen += 1;
    else if (b.state === "closed" && (b.failuresInWindow || 0) > 0) breakers.preTrip += 1;
  }

  const degraded = db !== "ok" || breakers.open > 0 || breakers.halfOpen > 0;
  return NextResponse.json(
    { ok: !degraded, degraded, checks: { db, connections, breakers } },
    { status: degraded ? 503 : 200, headers: CORS_HEADERS },
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
