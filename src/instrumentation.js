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

    // Loud startup warning when at-rest credential encryption is off:
    // without PRO_CREDENTIAL_KEY, provider credentials are stored in
    // plaintext. Never log the key itself — only whether it is configured.
    const { isKeyConfigured } = await import("@/lib/atRestCrypto.js");
    if (!isKeyConfigured()) {
      console.warn(
        "[security] WARNING: PRO_CREDENTIAL_KEY is not set — provider credentials are stored in PLAINTEXT. " +
        "Generate one with `openssl rand -hex 32`, set it in the environment, restart, then run the encryption migration (POST /api/settings/encryption). " +
        "Keep a copy of the key — encrypted rows cannot be decrypted without it."
      );
    }
  }
}
