// Internal service token for server-side consumers (pro.29, audit item 3
// follow-up). Router API keys are hashed at rest, so internal callers can
// no longer read a usable plaintext key from the apiKeys table. This module
// provides a stable server-side token instead, used ONLY by:
//   - the dashboard model test (ping.js getInternalHeaders)
//   - MITM auto-start (initializeApp.js startMitm ROUTER_API_KEY)
//   - CLI tool config resolution (resolveCliApiKey fallback)
// The token is NEVER returned by any API route and NEVER shown in the
// dashboard. It is accepted by validateApiKey as a valid unrestricted key.
// Source: INTERNAL_API_KEY env if set, else a value persisted once in
// settings (internalApiKey) — generated with crypto.randomBytes, stable
// across restarts. The settings route strips + protects it.
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { getSettings, updateSettings } from "@/lib/db/repos/settingsRepo.js";

let cachedToken = null;

export async function getInternalApiToken() {
  const envToken = (process.env.INTERNAL_API_KEY || "").trim();
  if (envToken) return envToken;
  if (cachedToken) return cachedToken;
  const settings = await getSettings().catch(() => null);
  if (settings?.internalApiKey && typeof settings.internalApiKey === "string") {
    cachedToken = settings.internalApiKey;
    return cachedToken;
  }
  const token = randomBytes(24).toString("hex");
  await updateSettings({ internalApiKey: token }).catch(() => {});
  cachedToken = token;
  return token;
}

// Constant-time check on fixed-length SHA-256 digests. Never compares raw
// strings and never throws.
export async function isInternalApiToken(key) {
  if (!key || typeof key !== "string") return false;
  const token = await getInternalApiToken().catch(() => null);
  if (!token) return false;
  const a = createHash("sha256").update(key).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

// Test seam: clear the module-level cache so a fresh settings read happens.
export function __resetInternalApiTokenCache() {
  cachedToken = null;
}
