import { NextResponse } from "next/server";
import { createProxyPool, getProviderConnections, getProxyPools } from "@/models";

function toBoolean(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

const VALID_PROXY_TYPES = ["http", "vercel", "cloudflare", "deno", "netlify"];

function normalizeProxyPoolInput(body = {}) {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const proxyUrl = typeof body?.proxyUrl === "string" ? body.proxyUrl.trim() : "";
  const noProxy = typeof body?.noProxy === "string" ? body.noProxy.trim() : "";
  const isActive = body?.isActive === undefined ? true : body.isActive === true;
  const strictProxy = body?.strictProxy === true;
  const type = VALID_PROXY_TYPES.includes(body?.type) ? body.type : "http";

  if (!name) {
    return { error: "Name is required" };
  }

  if (!proxyUrl) {
    return { error: "Proxy URL is required" };
  }

  return { name, proxyUrl, noProxy, isActive, strictProxy, type };
}

function buildUsageMap(connections = []) {
  const usageMap = new Map();

  for (const connection of connections) {
    const proxyPoolId = connection?.providerSpecificData?.proxyPoolId;
    if (!proxyPoolId) continue;

    usageMap.set(proxyPoolId, (usageMap.get(proxyPoolId) || 0) + 1);
  }

  return usageMap;
}

// GET /api/proxy-pools - List proxy pools
// No page/pageSize params → legacy full list (used by provider pickers).
// With page/pageSize → one page + total/activeCount/failedCount.
// ?search= filters by pool name (case-insensitive substring).
// ?idsOnly=1 returns just { ids, total } for the current filter+search
// (bulk actions that target "all pools" without downloading every row).
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const isActive = toBoolean(searchParams.get("isActive"));
    const includeUsage = searchParams.get("includeUsage") === "true";
    const idsOnly = searchParams.get("idsOnly") === "true";
    const search = (searchParams.get("search") || "").trim().toLowerCase();
    const hasPage = searchParams.has("page") || searchParams.has("pageSize");
    const page = Math.max(1, Number.parseInt(searchParams.get("page") || "1", 10) || 1);
    const pageSizeRaw = Number.parseInt(searchParams.get("pageSize") || "", 10);
    const pageSize = [10, 20, 50].includes(pageSizeRaw) ? pageSizeRaw : 50;

    const filter = {};
    if (isActive !== undefined) {
      filter.isActive = isActive;
    }

    let proxyPools = await getProxyPools(filter);
    if (search) {
      proxyPools = proxyPools.filter((pool) => (pool.name || "").toLowerCase().includes(search));
    }

    if (idsOnly) {
      return NextResponse.json({ ids: proxyPools.map((pool) => pool.id), total: proxyPools.length });
    }

    if (!hasPage) {
      if (!includeUsage) {
        return NextResponse.json({ proxyPools });
      }

      const connections = await getProviderConnections();
      const usageMap = buildUsageMap(connections);

      const enrichedProxyPools = proxyPools.map((pool) => ({
        ...pool,
        boundConnectionCount: usageMap.get(pool.id) || 0,
      }));

      return NextResponse.json({ proxyPools: enrichedProxyPools });
    }

    const total = proxyPools.length;
    const activeCount = proxyPools.filter((pool) => pool.isActive === true).length;
    const failedCount = proxyPools.filter((pool) => pool.testStatus === "error").length;
    const start = (page - 1) * pageSize;
    let pagePools = proxyPools.slice(start, start + pageSize);

    if (includeUsage) {
      const connections = await getProviderConnections();
      const usageMap = buildUsageMap(connections);
      pagePools = pagePools.map((pool) => ({
        ...pool,
        boundConnectionCount: usageMap.get(pool.id) || 0,
      }));
    }

    return NextResponse.json({ proxyPools: pagePools, total, activeCount, failedCount, page, pageSize });
  } catch (error) {
    console.log("Error fetching proxy pools:", error);
    return NextResponse.json({ error: "Failed to fetch proxy pools" }, { status: 500 });
  }
}

// POST /api/proxy-pools - Create proxy pool
export async function POST(request) {
  try {
    const body = await request.json();
    const normalized = normalizeProxyPoolInput(body);

    if (normalized.error) {
      return NextResponse.json({ error: normalized.error }, { status: 400 });
    }

    const proxyPool = await createProxyPool(normalized);
    return NextResponse.json({ proxyPool }, { status: 201 });
  } catch (error) {
    console.log("Error creating proxy pool:", error);
    return NextResponse.json({ error: "Failed to create proxy pool" }, { status: 500 });
  }
}
