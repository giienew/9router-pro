import { NextResponse } from "next/server";
import {
  getProviderConnections,
  classifyConnectionHealth,
  deleteProviderConnectionsByIds,
} from "@/models";
import { testSingleConnection } from "../providers/[id]/test/testUtils.js";

// Key Health (9Router Pro) — pool hygiene for large connection pools:
// classify every connection of a provider into health buckets, test
// connections in bounded batches, and bulk-delete the dead ones.
// Classification reuses the state the request path already maintains
// (testStatus / lastError / rateLimitedUntil / modelLock_*); nothing new
// is tracked. Credentials are never projected into the response.

const BUCKETS = ["active", "cooldown", "unavailable", "error", "unknown", "disabled"];
const TEST_BATCH_CAP = 25;
const DELETE_DEAD_CAP = 20000;

function project(conn, status) {
  return {
    id: conn.id,
    name: conn.name || conn.email || conn.id,
    email: conn.email || null,
    authType: conn.authType || null,
    isActive: conn.isActive !== false,
    status,
    testStatus: conn.testStatus || null,
    lastError: typeof conn.lastError === "string" ? conn.lastError.slice(0, 200) : null,
    lastErrorAt: conn.lastErrorAt || null,
    lastTested: conn.lastTested || null,
    rateLimitedUntil: conn.rateLimitedUntil || null,
  };
}

async function loadClassified(provider) {
  const conns = await getProviderConnections({ provider });
  const now = Date.now();
  return conns.map((c) => ({ conn: c, status: classifyConnectionHealth(c, now) }));
}

// GET /api/key-health?provider=&status=&search=&page=&pageSize=
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider") || "";
    if (!provider) return NextResponse.json({ error: "provider is required" }, { status: 400 });
    const statusFilter = searchParams.get("status") || "";
    const search = (searchParams.get("search") || "").trim().toLowerCase();
    const page = Math.max(1, Math.floor(Number(searchParams.get("page"))) || 1);
    const pageSize = Math.min(200, Math.max(1, Math.floor(Number(searchParams.get("pageSize"))) || 50));

    const classified = await loadClassified(provider);
    const counts = { total: classified.length };
    for (const b of BUCKETS) counts[b] = 0;
    for (const item of classified) counts[item.status] = (counts[item.status] || 0) + 1;

    let filtered = classified;
    if (statusFilter && BUCKETS.includes(statusFilter)) {
      filtered = filtered.filter((i) => i.status === statusFilter);
    }
    if (search) {
      filtered = filtered.filter(({ conn }) =>
        (conn.name || "").toLowerCase().includes(search) || (conn.email || "").toLowerCase().includes(search)
      );
    }

    const total = filtered.length;
    const slice = filtered.slice((page - 1) * pageSize, page * pageSize);
    return NextResponse.json({
      provider,
      counts,
      total,
      page,
      pageSize,
      connections: slice.map(({ conn, status }) => project(conn, status)),
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST /api/key-health — { action: "test", ids } | { action: "delete", ids }
//                       | { action: "deleteDead", provider }
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const action = body?.action;

    if (action === "test") {
      const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === "string" && x).slice(0, TEST_BATCH_CAP) : [];
      if (!ids.length) return NextResponse.json({ error: "ids is required" }, { status: 400 });
      const results = [];
      let idx = 0;
      const workers = Array.from({ length: Math.min(3, ids.length) }, async () => {
        while (idx < ids.length) {
          const id = ids[idx++];
          try {
            const r = await testSingleConnection(id);
            results.push({ id, valid: !!r.valid, error: r.error || null, latencyMs: r.latencyMs || 0 });
          } catch (e) {
            results.push({ id, valid: false, error: e?.message || "test failed", latencyMs: 0 });
          }
        }
      });
      await Promise.all(workers);
      return NextResponse.json({ results });
    }

    if (action === "delete") {
      const ids = Array.isArray(body.ids) ? body.ids : [];
      if (!ids.length) return NextResponse.json({ error: "ids is required" }, { status: 400 });
      const deleted = await deleteProviderConnectionsByIds(ids);
      return NextResponse.json({ deleted });
    }

    if (action === "deleteDead") {
      const provider = body.provider || "";
      if (!provider) return NextResponse.json({ error: "provider is required" }, { status: 400 });
      const classified = await loadClassified(provider);
      const deadIds = classified
        .filter((i) => i.status === "unavailable" || i.status === "error")
        .map((i) => i.conn.id)
        .slice(0, DELETE_DEAD_CAP);
      const deleted = await deleteProviderConnectionsByIds(deadIds);
      return NextResponse.json({ deleted, matched: deadIds.length });
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
