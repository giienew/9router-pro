import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings, updateSettings } from "@/lib/localDb";
import {
  ensurePasswordReady,
  getTokenVersion,
  setDashboardAuthCookie,
  verifyStoredPassword,
} from "@/lib/auth/dashboardSession";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resetComboRotation } from "open-sse/services/combo.js";
import { DATA_FILE } from "@/lib/db/paths.js";
import { apiErrorResponse } from "@/lib/apiError.js";
import { checkSsoOnlyGate, SSO_ONLY_MODES } from "@/lib/auth/ssoTestGate.js";
import bcrypt from "bcryptjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SETTINGS_RESPONSE_HEADERS = {
  "Cache-Control": "no-store"
};

// Secrets must never be mass-assigned from request body (CWE-915).
// ssoLastTestOk is server-managed (SSO test gate) — a client must never be
// able to forge a test pass through PATCH.
const PROTECTED_SETTING_KEYS = ["password", "tokenVersion", "mitmSudoEncrypted", "ssoLastTestOk", "internalApiKey"];

export async function GET() {
  try {
    const settings = await getSettings();
    const { password, oidcClientSecret, mitmSudoEncrypted, internalApiKey, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    // opt44: the SSO test-pass fingerprint is server-managed — never expose
    // it through the dashboard API. databasePath is the real server-side
    // location (fixes the hardcoded "~/.9router/db/data.sqlite" label).
    delete safeSettings.ssoLastTestOk;
    safeSettings.databasePath = DATA_FILE;
    
    const enableRequestLogs = process.env.ENABLE_REQUEST_LOGS === "true";
    const enableTranslator = process.env.ENABLE_TRANSLATOR === "true";
    
    return NextResponse.json({ 
      ...safeSettings, 
      enableRequestLogs,
      enableTranslator,
      hasPassword: !!(password || process.env.INITIAL_PASSWORD)
    }, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error getting settings:", error);
    return apiErrorResponse(error, { code: "settings_load_failed", message: "Failed to load settings. Please try again." });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();

    // Strip protected secrets before any internal handling sets them
    for (const key of PROTECTED_SETTING_KEYS) delete body[key];

    // If updating password, hash it
    if (body.newPassword) {
      // opt44: minimum length for NEW passwords (the env-only first-setup
      // rule below is untouched — this only gates the new value).
      if (String(body.newPassword).length < 8) {
        return NextResponse.json({ error: "New password must be at least 8 characters" }, { status: 400 });
      }
      // First-boot/legacy migration first: a set INITIAL_PASSWORD is
      // hashed into settings.password, so current-password verification
      // below always runs against a bcrypt hash — there is no plaintext
      // fallback list anymore.
      const settings = await ensurePasswordReady();
      const currentHash = settings.password;

      // Verify current password if it exists (bcrypt-only).
      if (currentHash) {
        if (!body.currentPassword) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await verifyStoredPassword(body.currentPassword, currentHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      }
      // No password configured yet: first-time set, no current password needed.

      const salt = await bcrypt.genSalt(10);
      body.password = await bcrypt.hash(body.newPassword, salt);
      // Revoke every pre-change session: bump the token epoch so tokens
      // issued before this change fail verification afterwards.
      body.tokenVersion = getTokenVersion(settings) + 1;
      delete body.newPassword;
      delete body.currentPassword;
    }

    if (Object.prototype.hasOwnProperty.call(body, "oidcClientSecret")) {
      if (!body.oidcClientSecret || !String(body.oidcClientSecret).trim()) {
        delete body.oidcClientSecret;
      }
    }

    // opt46 (A1/A2): one-level deep merge for nested objects the dashboard
    // saves partially, so a partial save cannot silently drop sibling keys
    // (responseCache.semantic, dbMaintenance.lastRunAt/lastResult).
    if (body.responseCache && typeof body.responseCache === "object" && !Array.isArray(body.responseCache)) {
      const current = await getSettings();
      body.responseCache = { ...(current.responseCache || {}), ...body.responseCache };
    }
    if (body.dbMaintenance && typeof body.dbMaintenance === "object" && !Array.isArray(body.dbMaintenance)) {
      const current = await getSettings();
      body.dbMaintenance = { ...(current.dbMaintenance || {}), ...body.dbMaintenance };
    }

    // opt44: SSO-only gate — switching to a password-less mode requires a
    // successful connection test of the exact configuration being saved.
    // opt46 (M1-SSO): also gate when the instance is ALREADY SSO-only and
    // an IdP field changes — the old code only gated the authMode switch
    // itself, so an untested IdP edit could lock out password login.
    // (When the merged mode still allows password login, the gate is a
    // no-op by construction, so gating on IdP-field presence is safe.)
    const IDP_FIELDS = ["samlEntryPoint", "samlIssuer", "samlCert", "oidcIssuerUrl", "oidcClientId", "oidcClientSecret", "ssoType"];
    const needsSsoGate =
      (body.authMode && SSO_ONLY_MODES.includes(body.authMode)) ||
      IDP_FIELDS.some((k) => Object.prototype.hasOwnProperty.call(body, k));
    if (needsSsoGate) {
      const current = await getSettings();
      const gateError = checkSsoOnlyGate({ ...current, ...body });
      if (gateError) {
        return NextResponse.json({ error: gateError }, { status: 400 });
      }
    }

    const passwordChanged = Object.prototype.hasOwnProperty.call(body, "password");
    const settings = await updateSettings(body);

    // The password change bumped tokenVersion above, which revokes every
    // pre-change token — including the caller's own. Re-issue a fresh
    // token for the caller so the legitimate admin stays logged in while
    // stolen pre-change tokens die. Best-effort: the password change
    // itself already succeeded even if cookie re-issue fails.
    if (passwordChanged) {
      try {
        const cookieStore = await cookies();
        await setDashboardAuthCookie(cookieStore, request);
      } catch {}
    }

    // Apply outbound proxy settings immediately (no restart required)
    if (
      Object.prototype.hasOwnProperty.call(body, "outboundProxyEnabled") ||
      Object.prototype.hasOwnProperty.call(body, "outboundProxyUrl") ||
      Object.prototype.hasOwnProperty.call(body, "outboundNoProxy")
    ) {
      applyOutboundProxyEnv(settings);
    }

    // Invalidate combo rotation state when strategy settings change
    if (
      Object.prototype.hasOwnProperty.call(body, "comboStrategy") ||
      Object.prototype.hasOwnProperty.call(body, "comboStickyRoundRobinLimit") ||
      Object.prototype.hasOwnProperty.call(body, "comboStrategies")
    ) {
      resetComboRotation();
    }

    if (
      Object.prototype.hasOwnProperty.call(body, "claudeAutoPing") ||
      Object.prototype.hasOwnProperty.call(body, "codexAutoPing")
    ) {
      // Keep the scheduler absent when no account opted in; load its provider graph only on demand.
      import("@/shared/services/quotaAutoPing")
        .then(({ configureQuotaAutoPing }) => {
          configureQuotaAutoPing(settings);
        })
        .catch((error) => console.warn("[AutoPing] settings update failed:", error.message));
    }

    const { password, oidcClientSecret, mitmSudoEncrypted, internalApiKey, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    delete safeSettings.ssoLastTestOk;
    safeSettings.databasePath = DATA_FILE;
    return NextResponse.json(safeSettings, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error updating settings:", error);
    return apiErrorResponse(error, { code: "settings_update_failed", message: "Failed to update settings. Please try again." });
  }
}
