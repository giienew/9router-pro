import fs from "node:fs";
import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { DATA_FILE } from "@/lib/db/paths.js";
import { invalidateSemanticEntries } from "@/lib/semanticCache.js";
import { invalidateModelsListCache } from "@/sse/services/modelsListCache.js";
import { invalidateUserModelCaps } from "@/lib/userModelCaps.js";
import { getProviderBreakerSnapshot, __resetProviderBreakers } from "@/sse/services/providerBreaker.js";
import { getConsoleLogs, clearConsoleLogs } from "@/lib/consoleLogBuffer.js";
import { createSnapshot } from "@/lib/backup/autoBackup.js";
import { requireDashboardAuth, logAdminEvent } from "@/lib/admin/requireAdmin.js";
import {
  diskCleanup,
  findPm2Target,
  schedulePm2Restart,
  flushPm2Logs,
} from "@/lib/admin/maintenance.js";

export const dynamic = "force-dynamic";

// POST /api/admin/maintenance { action, ... } — destructive admin actions.
// Every action requires a dashboard session (API keys get 401), needs an
// explicit confirm step in the Admin UI, and writes one security-log row.
// Actions:
//   clear-semantic { model? } — semantic cache, all or per-model (count returned)
//   clear-models — /v1/models list cache + per-model caps cache
//     (the /api/models 30s payload cache self-expires; it is not stored)
//   clear-latency — cached latency payloads (count of periods cleared)
//   clear-monitoring — cached /api/monitoring payload (0/1)
//   clear-all-caches — all of the above in one call
//   clear-logs — truncate the dashboard-visible console log buffer
//   clear-pm2-logs — `pm2 flush` (PM2 hosts only; 503 when PM2 is absent)
//   reset-breakers — clear all in-memory provider breaker state (re-opens all)
//   vacuum — SQLite VACUUM (file size before/after returned)
//   backup-now — timestamped JSON snapshot via the auto-backup path
//   disk-cleanup — old deploy tarballs (keep 2) + old DB backups/snapshots
//   refresh-tokens — run the 5-min background token-refresh tick on demand
//   restart — graceful `pm2 restart` of the 9Router process (PM2 hosts only)
const ACTIONS = new Set([
  "clear-semantic", "clear-models", "clear-latency", "clear-monitoring",
  "clear-all-caches", "clear-logs", "clear-pm2-logs", "reset-breakers",
  "vacuum", "backup-now", "disk-cleanup", "refresh-tokens", "restart",
]);

async function clearSemantic(model) {
  const db = await getAdapter();
  const removed = invalidateSemanticEntries(db, model || null);
  return { removed, model: model || null };
}

async function clearModels() {
  invalidateModelsListCache();
  try { invalidateUserModelCaps(); } catch {}
  return { cleared: true, note: "Models-list + per-model caps caches cleared. The /api/models 30s payload cache expires on its own." };
}

async function clearLatency() {
  const mod = await import("@/app/api/usage/latency/route.js");
  const cleared = typeof mod.__clearLatencyCache === "function" ? mod.__clearLatencyCache() : 0;
  return { cleared };
}

async function clearMonitoring() {
  const mod = await import("@/app/api/monitoring/route.js");
  const cleared = typeof mod.__clearMonitoringCache === "function" ? mod.__clearMonitoringCache() : 0;
  return { cleared };
}

export async function POST(request) {
  try {
    if (!(await requireDashboardAuth())) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const body = await request.json().catch(() => ({}));
    const action = body?.action;
    if (!action || !ACTIONS.has(action)) {
      return NextResponse.json({ error: "Unknown action", actions: [...ACTIONS] }, { status: 400 });
    }

    let result = null;

    if (action === "clear-semantic") {
      const model = typeof body?.model === "string" && body.model.trim() ? body.model.trim() : null;
      result = await clearSemantic(model);
    } else if (action === "clear-models") {
      result = await clearModels();
    } else if (action === "clear-latency") {
      result = await clearLatency();
    } else if (action === "clear-monitoring") {
      result = await clearMonitoring();
    } else if (action === "clear-all-caches") {
      const model = typeof body?.model === "string" && body.model.trim() ? body.model.trim() : null;
      const [semantic, models, latency, monitoring] = await Promise.all([
        clearSemantic(model), clearModels(), clearLatency(), clearMonitoring(),
      ]);
      result = { semantic, models, latency, monitoring };
    } else if (action === "clear-logs") {
      const before = getConsoleLogs().length;
      clearConsoleLogs();
      result = { clearedLines: before };
    } else if (action === "clear-pm2-logs") {
      const pm2 = await findPm2Target();
      if (!pm2.available) {
        return NextResponse.json({ error: "PM2 is not available on this host — PM2 logs can only be flushed where PM2 manages the app" }, { status: 503 });
      }
      const flushed = await flushPm2Logs();
      if (!flushed.ok) {
        return NextResponse.json({ error: `pm2 flush failed: ${flushed.error || "unknown error"}` }, { status: 502 });
      }
      result = { flushed: true };
    } else if (action === "reset-breakers") {
      const before = getProviderBreakerSnapshot();
      __resetProviderBreakers();
      result = { resetProviders: Object.keys(before).length, providers: Object.keys(before) };
    } else if (action === "vacuum") {
      const db = await getAdapter();
      const beforeBytes = (() => { try { return fs.statSync(DATA_FILE).size; } catch { return null; } })();
      let vacuum = "done";
      try { db.run("VACUUM"); } catch { vacuum = "skipped"; }
      const afterBytes = (() => { try { return fs.statSync(DATA_FILE).size; } catch { return null; } })();
      result = { vacuum, beforeBytes, afterBytes, freedBytes: beforeBytes != null && afterBytes != null ? Math.max(0, beforeBytes - afterBytes) : null };
    } else if (action === "backup-now") {
      const snapshot = await createSnapshot("manual");
      result = { snapshot };
    } else if (action === "disk-cleanup") {
      result = await diskCleanup();
    } else if (action === "refresh-tokens") {
      const { selectConnectionsNeedingRefresh, runBackgroundTokenRefreshTick } =
        await import("@/sse/services/backgroundTokenRefresh.js");
      const { getProviderConnections } = await import("@/lib/db/repos/connectionsRepo.js");
      let due = 0;
      try {
        const connections = await getProviderConnections({ isActive: true });
        due = selectConnectionsNeedingRefresh(connections, Date.now()).length;
      } catch {}
      await runBackgroundTokenRefreshTick();
      result = { triggered: true, dueConnections: due };
    } else if (action === "restart") {
      const pm2 = await findPm2Target();
      if (!pm2.available || !pm2.target) {
        return NextResponse.json({ error: "PM2 is not managing 9Router on this host — restart from your process manager instead (no restart was attempted)" }, { status: 503 });
      }
      const name = pm2.target.name;
      await logAdminEvent("admin-restart", `PM2 restart requested for process "${name}"`);
      const response = NextResponse.json({
        restarting: true,
        process: name,
        note: "Restarting via PM2 — the app should come back within seconds. Poll /api/health or the System status card for the new BUILD_ID.",
      });
      schedulePm2Restart(name);
      return response;
    }

    await logAdminEvent("admin-maintenance", `Maintenance action: ${action}`);
    return NextResponse.json({ success: true, action, result });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}
