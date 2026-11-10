export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    // Server-only: lets capabilities.js read the user's per-model overrides
    // (model editor) without pulling the DB into the browser bundle.
    const { installUserCapsSource } = await import("@/lib/userModelCaps.js");
    await installUserCapsSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    const { startAutoBackupScheduler } = await import("@/lib/backup/autoBackup.js");
    startAutoBackupScheduler();

    const { startMaintenanceScheduler } = await import("@/lib/db/maintenance.js");
    startMaintenanceScheduler();
  }
}
