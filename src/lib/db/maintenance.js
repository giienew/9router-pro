// Scheduled DB maintenance (9Router Pro): prune old per-request history and
// expired cache rows, then reclaim space. Daily rollups (usageDaily) are
// aggregates and are kept forever — pruning them would erase long-term
// stats. VACUUM is best-effort: some adapters (sql.js) persist differently
// and report it as skipped instead of failing the run.
import { getAdapter } from "@/lib/db/driver.js";
import { getSettings, updateSettings } from "@/lib/localDb";

const DAY_MS = 24 * 3600 * 1000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60 * 1000;

function changesOf(result) {
  return typeof result?.changes === "number" ? result.changes : 0;
}

// Pure over a db adapter (real or fake) so tests can drive it directly.
export async function runMaintenance(db, { retentionDays = 90 } = {}) {
  const cutoff = new Date(Date.now() - Math.max(1, retentionDays) * DAY_MS).toISOString();
  const now = new Date().toISOString();
  const prunedUsage = changesOf(db.run(`DELETE FROM usageHistory WHERE timestamp < ?`, [cutoff]));
  const prunedDetails = changesOf(db.run(`DELETE FROM requestDetails WHERE timestamp < ?`, [cutoff]));
  const prunedCache = changesOf(db.run(`DELETE FROM responseCache WHERE expiresAt < ?`, [now]));
  let vacuum = "done";
  try {
    db.run(`VACUUM`);
  } catch {
    vacuum = "skipped";
  }
  return { cutoff, prunedUsage, prunedDetails, prunedCache, vacuum, ranAt: now };
}

export async function runMaintenanceNow() {
  const settings = await getSettings();
  const cfg = settings.dbMaintenance || {};
  const db = await getAdapter();
  const result = await runMaintenance(db, { retentionDays: cfg.retentionDays ?? 90 });
  await updateSettings({
    dbMaintenance: { ...cfg, lastRunAt: result.ranAt, lastResult: result },
  });
  return result;
}

let timer = null;

export function startMaintenanceScheduler() {
  if (timer) return;
  const check = async () => {
    try {
      const settings = await getSettings();
      const cfg = settings.dbMaintenance || {};
      if (cfg.enabled !== false) {
        const last = cfg.lastRunAt ? new Date(cfg.lastRunAt).getTime() : 0;
        if (Date.now() - last >= DAY_MS) await runMaintenanceNow();
      }
    } catch (e) {
      console.warn("[Maintenance] check failed:", e?.message || e);
    }
    timer = setTimeout(check, CHECK_INTERVAL_MS);
    timer.unref?.();
  };
  timer = setTimeout(check, STARTUP_DELAY_MS);
  timer.unref?.();
}
