import { NextResponse } from "next/server";
import { bulkAssignProxyPool } from "@/lib/db/repos/connectionsRepo";
import { getProxyPoolById, getProxyPools } from "@/lib/db/repos/proxyPoolsRepo";

// POST /api/providers/bulk-proxy — assign a proxy pool to EVERY connection of
// a provider in one server-side pass. The detail page's Apply Proxy otherwise
// only reaches the connections currently loaded in the browser (one page).
// Body: { provider, mode: "single" | "rotate" | "none", proxyPoolId? }
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const provider = typeof body?.provider === "string" ? body.provider.trim() : "";
  const mode = body?.mode;
  if (!provider) {
    return NextResponse.json({ error: "provider is required" }, { status: 400 });
  }

  if (mode === "none") {
    const updated = await bulkAssignProxyPool(provider, null);
    return NextResponse.json({ updated });
  }
  if (mode === "single") {
    const proxyPoolId = typeof body?.proxyPoolId === "string" ? body.proxyPoolId.trim() : "";
    if (!proxyPoolId) {
      return NextResponse.json({ error: "proxyPoolId is required" }, { status: 400 });
    }
    const pool = await getProxyPoolById(proxyPoolId);
    if (!pool) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }
    const updated = await bulkAssignProxyPool(provider, [proxyPoolId]);
    return NextResponse.json({ updated });
  }
  if (mode === "rotate") {
    const pools = await getProxyPools({ isActive: true });
    if (!pools.length) {
      return NextResponse.json({ error: "No active proxy pools available" }, { status: 400 });
    }
    const updated = await bulkAssignProxyPool(provider, pools.map((p) => p.id));
    return NextResponse.json({ updated });
  }
  return NextResponse.json({ error: "mode must be single, rotate or none" }, { status: 400 });
}
