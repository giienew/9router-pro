// SSO-only gate (opt44): switching Auth Mode to a password-less mode
// ("sso", "saml", "oidc") requires a successful connection test of the
// exact configuration being saved. The test endpoints record a fingerprint
// (SHA-256 over the normalized tested fields — the secret itself is never
// stored, only its hash) into settings.ssoLastTestOk; PATCH /api/settings
// rejects an SSO-only switch whose merged config fingerprint does not
// match the recorded test. "both" and "password" are never gated: password
// login still works there, so a bad IdP config cannot lock anyone out.
// ssoLastTestOk is server-managed: PATCH strips any client-supplied value
// (see PROTECTED_SETTING_KEYS) and the settings responses strip it back,
// so a test pass cannot be forged through the API.
import { createHash } from "node:crypto";
import { getSettings, updateSettings } from "@/lib/localDb";

export const SSO_ONLY_MODES = ["sso", "saml", "oidc"];

const norm = (v) => String(v || "").trim();

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function fingerprintSaml({ samlEntryPoint, samlIssuer, samlCert }) {
  return sha256(["saml", norm(samlEntryPoint), norm(samlIssuer), norm(samlCert)].join("\n"));
}

export function fingerprintOidc({ oidcIssuerUrl, oidcClientId, oidcClientSecret }) {
  return sha256(["oidc", norm(oidcIssuerUrl), norm(oidcClientId), norm(oidcClientSecret)].join("\n"));
}

export function ssoTypeFor(settings, authMode) {
  if (settings.ssoType === "saml" || settings.ssoType === "oidc") return settings.ssoType;
  return authMode === "saml" ? "saml" : "oidc";
}

export function requiredSsoFields(settings, type) {
  if (type === "saml") {
    return ["samlEntryPoint", "samlIssuer", "samlCert"].filter((k) => !norm(settings[k]));
  }
  return ["oidcIssuerUrl", "oidcClientId", "oidcClientSecret"].filter((k) => !norm(settings[k]));
}

export function fingerprintForSettings(settings, type) {
  return type === "saml" ? fingerprintSaml(settings) : fingerprintOidc(settings);
}

// Returns an error string when the switch must be rejected, or null when allowed.
export function checkSsoOnlyGate(merged) {
  if (!SSO_ONLY_MODES.includes(merged.authMode)) return null;
  const type = ssoTypeFor(merged, merged.authMode);
  const missing = requiredSsoFields(merged, type);
  if (missing.length) {
    return `SSO configuration is incomplete (${missing.join(", ")}). Fill in the missing fields and test the connection first, or choose Both to keep password login.`;
  }
  const recorded = merged.ssoLastTestOk?.[type];
  if (!recorded || recorded.fingerprint !== fingerprintForSettings(merged, type)) {
    return "This SSO configuration has not passed a connection test. Test the connection first, or choose Both to keep password login.";
  }
  return null;
}

export async function recordSsoTestOk(type, fingerprint) {
  const settings = await getSettings();
  const prev = settings.ssoLastTestOk || {};
  await updateSettings({
    ssoLastTestOk: { ...prev, [type]: { fingerprint, testedAt: new Date().toISOString() } },
  });
}
