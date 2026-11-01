import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resetComboRotation } from "open-sse/services/combo.js";
import { DATA_FILE } from "@/lib/db/paths.js";
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
const PROTECTED_SETTING_KEYS = ["password", "mitmSudoEncrypted", "ssoLastTestOk"];

export async function GET() {
  try {
    const settings = await getSettings();
    const { password, oidcClientSecret, ...safeSettings } = settings;
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
    return NextResponse.json({ error: error.message }, { status: 500 });
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
      const settings = await getSettings();
      const currentHash = settings.password;

      // Verify current password if it exists
      if (currentHash) {
        if (!body.currentPassword) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await bcrypt.compare(body.currentPassword, currentHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      } else {
        // First time setting password, no current password needed.
        // Accept an empty currentPassword, the built-in default, or the
        // operator's custom INITIAL_PASSWORD env value (opt46 P2: the old
        // code rejected a correct custom env password with 401 even
        // though GET reports hasPassword=true when the env is set).
        const acceptedCurrent = ["9routerpro", process.env.INITIAL_PASSWORD].filter(Boolean);
        if (body.currentPassword && !acceptedCurrent.includes(body.currentPassword)) {
           return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      }

      const salt = await bcrypt.genSalt(10);
      body.password = await bcrypt.hash(body.newPassword, salt);
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

    const settings = await updateSettings(body);

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

    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    delete safeSettings.ssoLastTestOk;
    safeSettings.databasePath = DATA_FILE;
    return NextResponse.json(safeSettings, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error updating settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
