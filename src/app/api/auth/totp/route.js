import { NextResponse } from "next/server";
import { getTotpConfig, startTotpSetup, enableTotp, disableTotp } from "@/lib/auth/totp.js";

export const dynamic = "force-dynamic";

// Dashboard-session protected by middleware (not a public auth path).
export async function GET() {
  try {
    const cfg = await getTotpConfig();
    return NextResponse.json({
      enabled: cfg.enabled === true,
      backupCodesRemaining: (cfg.backupHashes || []).length,
      hasPendingSetup: Boolean(cfg.pendingSecret),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}

// Setup step 1: returns the secret + otpauth URL + backup codes ONCE.
// Nothing is enforced until POST /enable proves a valid code.
export async function POST(request) {
  try {
    const { action, code } = await request.json();
    if (action === "setup") {
      const cfg = await getTotpConfig();
      if (cfg.enabled) return NextResponse.json({ error: "TOTP is already enabled" }, { status: 400 });
      const out = await startTotpSetup();
      return NextResponse.json(out);
    }
    if (action === "enable") {
      const ok = await enableTotp(code);
      if (!ok) return NextResponse.json({ error: "Invalid authenticator code" }, { status: 401 });
      return NextResponse.json({ enabled: true });
    }
    if (action === "disable") {
      const ok = await disableTotp(code);
      if (!ok) return NextResponse.json({ error: "Invalid authenticator or backup code" }, { status: 401 });
      return NextResponse.json({ enabled: false });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}
