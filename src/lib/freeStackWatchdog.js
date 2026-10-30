// Free-stack watchdog (R1): boot-armed scheduler in the auto-backup
// pattern — one timer chain per process, startup delay, hourly checks,
// unref'd so it never keeps the process alive. It RE-PROBES and stores a
// fresh draft + a trust event when the draft changes; it NEVER applies
// anything — applying still needs a dashboard approval (POST apply:true).
// Enabled only when settings.freeStackWatchdogEnabled is true or
// FREE_STACK_WATCHDOG=on; default off so a fresh install does no extra work.
import { makeKv } from "@/lib/db/helpers/kvStore.js";

const kv = makeKv("freeStack");
let timer = null;

export function startFreeStackWatchdog() {
  if (timer) return;
  if (String(process.env.FREE_STACK_WATCHDOG || "").toLowerCase() === "off") return;
  const intervalMs = Math.max(60000, Number(process.env.FREE_STACK_INTERVAL_MS) || 3600 * 1000);
  const check = async () => {
    try {
      const { getSettings } = await import("@/lib/localDb");
      const settings = await getSettings();
      const enabled = settings?.freeStackWatchdogEnabled === true || String(process.env.FREE_STACK_WATCHDOG || "").toLowerCase() === "on";
      if (enabled) {
        const { buildAdvisorCandidates, buildAdvisorDraft } = await import("@/lib/comboAdvisorServer.js");
        const { candidates } = await buildAdvisorCandidates({ probe: false });
        const draft = buildAdvisorDraft(candidates, "free");
        const prev = await kv.get("latestDraft", null);
        await kv.set("latestDraft", { ...draft, at: new Date().toISOString() });
        if (JSON.stringify(prev?.members || []) !== JSON.stringify(draft.members || [])) {
          const { getAdapter } = await import("@/lib/db/driver.js");
          const { recordTrustEvent } = await import("@/lib/trustEvents.js");
          const db = await getAdapter();
          recordTrustEvent(db, { kind: "job", level: "info", subject: "free-stack", title: "Free stack draft refreshed", detail: `${draft.members.length} members; review on the Combos page before applying.` });
        }
      }
    } catch (e) {
      console.warn("[FreeStackWatchdog] check failed:", e?.message || e);
    }
    timer = setTimeout(check, intervalMs);
    timer.unref?.();
  };
  timer = setTimeout(check, 60000);
  timer.unref?.();
}
