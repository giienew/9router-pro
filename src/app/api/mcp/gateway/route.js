// Gateway MCP server (R5, 9Router Pro, original code) — Streamable-HTTP
// JSON-RPC at /api/mcp/gateway. Read-only tools only: an agent can inspect
// routing, providers, combos and health, but cannot change anything.
// Mutating tools are deliberately NOT shipped: they would need an explicit
// dashboard approval flow (approval queue UI), which is out of scope for
// this run — see the report. Every tool call is audit-trailed to the R3
// security log. Auth: a valid Pro API key (Bearer) or a dashboard session
// cookie. Tool outputs never include stored credentials (providers are
// returned redacted: id/provider/name/active/testStatus only).
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAdapter } from "@/lib/db/driver.js";
import { getProviderConnections, getCombos, validateApiKey, getProviderConnectionStats } from "@/lib/localDb";
import { recordSecurityEvent } from "@/lib/trustEvents.js";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TOOLS = [
  { name: "list_providers", description: "List connected providers (redacted: no credentials).", inputSchema: { type: "object", properties: { activeOnly: { type: "boolean" } } } },
  { name: "list_combos", description: "List combos with their member models.", inputSchema: { type: "object", properties: {} } },
  { name: "health_summary", description: "Per-provider connection counts and error counts.", inputSchema: { type: "object", properties: {} } },
  { name: "auto_routing_intents", description: "The auto: intents the router expands at serving time.", inputSchema: { type: "object", properties: {} } },
];

async function authorized(request) {
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (bearer) {
    try { if (await validateApiKey(bearer)) return true; } catch {}
  }
  try {
    const store = await cookies();
    if (await verifyDashboardAuthToken(store.get("auth_token")?.value || null)) return true;
  } catch {}
  return false;
}

async function audit(db, request, tool, ok) {
  try {
    recordSecurityEvent(db, { event: "mcp-tool-call", ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null, userAgent: request.headers.get("user-agent") || null, detail: `gateway tool ${tool} ${ok ? "ok" : "failed"}` });
  } catch {}
}

async function runTool(name, args) {
  switch (name) {
    case "list_providers": {
      const conns = await getProviderConnections();
      const list = conns
        .filter((c) => !args?.activeOnly || c.isActive !== false)
        .map((c) => ({ id: c.id, provider: c.provider, authType: c.authType, name: c.name, isActive: c.isActive !== false, testStatus: c.providerSpecificData?.testStatus || null }));
      return { providers: list, count: list.length };
    }
    case "list_combos": {
      const combos = await getCombos();
      return { combos: combos.map((c) => ({ id: c.id, name: c.name, kind: c.kind || null, models: c.models || [] })), count: combos.length };
    }
    case "health_summary": {
      const stats = await getProviderConnectionStats();
      return { providers: Object.values(stats).map((s) => ({ provider: s.provider, authType: s.authType, total: s.total, connected: s.connected, error: s.error })) };
    }
    case "auto_routing_intents": {
      const { AUTO_INTENTS } = await import("@/sse/services/autoRouting.js");
      return { intents: AUTO_INTENTS.map((i) => `auto:${i}`), note: "Serving-time selection only; the combo advisor (draft) is a separate dashboard feature." };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function GET() {
  return NextResponse.json({
    name: "9router-pro-gateway",
    version: "0.5.109-pro.15",
    protocol: "mcp-json-rpc-over-http",
    tools: TOOLS.map((t) => t.name),
    mutatingTools: [],
    note: "Read-only. Mutating tools are pending an explicit dashboard approval flow.",
  });
}

export async function POST(request) {
  if (!(await authorized(request))) {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized: pass a valid Pro API key as Bearer or a dashboard session cookie" } }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const id = body?.id ?? null;
  const db = await getAdapter().catch(() => null);
  const err = (code, message) => NextResponse.json({ jsonrpc: "2.0", id, error: { code, message } });
  const ok = (result) => NextResponse.json({ jsonrpc: "2.0", id, result });
  try {
    if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") return err(-32600, "Invalid JSON-RPC request");
    if (body.method === "initialize") {
      return ok({ protocolVersion: body.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "9router-pro-gateway", version: "0.5.109-pro.15" } });
    }
    if (body.method === "ping") return ok({});
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") return ok({ tools: TOOLS });
    if (body.method === "tools/call") {
      const name = body.params?.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        if (db) await audit(db, request, name || "unknown", false);
        return err(-32602, `Unknown tool: ${name} (mutating tools are not available: no approval flow yet)`);
      }
      const result = await runTool(name, body.params?.arguments || {});
      if (db) await audit(db, request, name, true);
      return ok({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
    }
    return err(-32601, `Method not found: ${body.method}`);
  } catch (e) {
    return err(-32603, e?.message || "Internal error");
  }
}
