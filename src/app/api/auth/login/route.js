import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  ensurePasswordReady,
  setDashboardAuthCookie,
  verifyStoredPassword,
} from "@/lib/auth/dashboardSession";
import { isOidcConfigured } from "@/lib/auth/oidc";
import { isSamlConfigured } from "@/lib/auth/saml.js";
import { checkLock, recordFail, recordSuccess, getClientIp } from "@/lib/auth/loginLimiter";
import { isTotpEnabled, verifyTotp, consumeBackupCode, getTotpConfig } from "@/lib/auth/totp.js";
import { getAdapter } from "@/lib/db/driver.js";
import { apiErrorResponse } from "@/lib/apiError.js";
import { recordSecurityEvent } from "@/lib/trustEvents.js";

const RESET_HINT = "Forgot password? Reset to default via 9Router CLI → Settings → Reset Password to Default.";
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function isTunnelRequest(request, settings) {
  const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
  const tunnelHost = settings.tunnelUrl ? new URL(settings.tunnelUrl).hostname.toLowerCase() : "";
  const tailscaleHost = settings.tailscaleUrl ? new URL(settings.tailscaleUrl).hostname.toLowerCase() : "";
  return (tunnelHost && host === tunnelHost) || (tailscaleHost && host === tailscaleHost);
}

export async function POST(request) {
  try {
    const ip = getClientIp(request);
    // R3: security audit log (fire-and-forget, never blocks sign-in).
    const audit = (event, detail) => {
      getAdapter()
        .then((db) => recordSecurityEvent(db, { event, ip, userAgent: request.headers.get("user-agent") || null, detail }))
        .catch(() => {});
    };
    const lock = checkLock(ip);
    if (lock.locked) {
      return NextResponse.json(
        { error: `Too many failed attempts. Try again in ${lock.retryAfter}s. ${RESET_HINT}`, retryAfter: lock.retryAfter, resetHint: RESET_HINT },
        { status: 429, headers: { "Retry-After": String(lock.retryAfter) } }
      );
    }

    const { password, totpCode } = await request.json();
    // First-boot/legacy migration: a set INITIAL_PASSWORD is hashed into
    // settings.password, and a legacy plaintext stored value is re-hashed
    // in place, before any verification happens. After this point the only
    // verification path is bcrypt against the stored hash — there is no
    // default password and no plaintext fallback.
    const settings = await ensurePasswordReady();

    // Block login via tunnel/tailscale if dashboard access is disabled
    if (isTunnelRequest(request, settings) && settings.tunnelDashboardAccess !== true) {
      return NextResponse.json({ error: "Dashboard access via tunnel is disabled" }, { status: 403 });
    }

    if (settings.authMode === "sso" || settings.authMode === "saml" || settings.authMode === "oidc") {
      const ssoType = settings.ssoType || (settings.authMode === "saml" ? "saml" : "oidc");
      if (ssoType === "saml" && isSamlConfigured(settings)) {
        return NextResponse.json({ error: "Password login is disabled. Use SAML SSO sign in." }, { status: 403 });
      }
      if (ssoType === "oidc" && isOidcConfigured(settings)) {
        return NextResponse.json({ error: "Password login is disabled. Use OIDC sign in." }, { status: 403 });
      }
    }

    const isValid = await verifyStoredPassword(password, settings.password);

    if (isValid) {
      // TOTP second factor (password login only): no session cookie is
      // issued until the code passes. A backup code (XXXX-XXXX) works in
      // place of a TOTP code and is consumed on use.
      if (await isTotpEnabled()) {
        const code = String(totpCode || "").trim();
        let totpOk = false;
        if (code.includes("-")) {
          totpOk = await consumeBackupCode(code);
        } else if (code) {
          const cfg = await getTotpConfig();
          totpOk = verifyTotp(cfg.secret, code);
        }
        if (!totpOk) {
          const { remainingBeforeLock } = recordFail(ip);
          audit("login-failed", "TOTP code rejected");
          return NextResponse.json(
            { error: `Invalid authenticator code. ${remainingBeforeLock} attempt(s) left before lockout.`, remainingBeforeLock, totpRequired: true },
            { status: 401, headers: NO_STORE_HEADERS }
          );
        }
      }

      recordSuccess(ip);

      const cookieStore = await cookies();
      await setDashboardAuthCookie(cookieStore, request);
      audit("login", await isTotpEnabled() ? "Password + TOTP verified" : "Password verified");

      return NextResponse.json({ success: true, mustChangePassword: false }, { headers: NO_STORE_HEADERS });
    }

    const { remainingBeforeLock } = recordFail(ip);
    const postLock = checkLock(ip);
    if (postLock.locked) {
      return NextResponse.json(
        { error: `Too many failed attempts. Try again in ${postLock.retryAfter}s. ${RESET_HINT}`, retryAfter: postLock.retryAfter, resetHint: RESET_HINT },
        { status: 429, headers: { "Retry-After": String(postLock.retryAfter) } }
      );
    }
    audit("login-failed", "Password rejected");
    return NextResponse.json(
      { error: `Invalid password. ${remainingBeforeLock} attempt(s) left before lockout.`, remainingBeforeLock },
      { status: 401 }
    );
  } catch (error) {
    return apiErrorResponse(error, { code: "login_failed", message: "Login failed. Please try again." });
  }
}
