import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getSettings } from "@/lib/localDb";
import { getTokenVersion, getDashboardAuthSession } from "@/lib/auth/dashboardSession.js";
import { isKeyConfigured, countRowEncryption } from "@/lib/atRestCrypto.js";
import { recordSuccess } from "@/lib/auth/loginLimiter.js";
import { requireDashboardAuth, logAdminEvent } from "@/lib/admin/requireAdmin.js";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

// GET /api/admin/security — Security center facts.
//   encryption: whether PRO_CREDENTIAL_KEY is configured + how many stored
//     credential fields are encrypted vs plaintext (counts only, never values).
//   lockouts: login-lockout rows (IP, fails, lock level, locked-until).
//   sessions: the dashboard token epoch + the caller's own token issue time.
//     Dashboard sessions are stateless JWTs: there is no server-side session
//     list, so "active sessions" is the token epoch — revoking bumps it and
//     invalidates every token issued before the bump.
export async function GET() {
  try {
    if (!(await requireDashboardAuth())) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const db = await getAdapter();

    let encryption = { configured: isKeyConfigured(), connections: 0, plaintext: 0, encrypted: 0 };
    try {
      // Read the RAW data column: getProviderConnections decrypts on read,
      // which would make every encrypted value look plaintext. Counting the
      // stored envelopes is the only honest encrypted-vs-plaintext split.
      const { parseJson } = await import("@/lib/db/helpers/jsonCol.js");
      const rows = db.all(`SELECT data FROM providerConnections`);
      let plaintext = 0;
      let encrypted = 0;
      for (const row of rows || []) {
        const c = countRowEncryption(parseJson(row?.data, {}));
        plaintext += c.plaintext;
        encrypted += c.encrypted;
      }
      encryption = { configured: isKeyConfigured(), connections: (rows || []).length, plaintext, encrypted };
    } catch {}

    let lockouts = [];
    try {
      const rows = db.all(
        `SELECT ip, fails, lockUntil, lockLevel, lastFailAt FROM loginLockouts ORDER BY lockUntil DESC, lastFailAt DESC LIMIT 100`,
      );
      const now = Date.now();
      lockouts = (rows || []).map((r) => ({
        ip: r.ip,
        fails: Number(r.fails) || 0,
        lockLevel: Number(r.lockLevel) || 0,
        lockUntil: Number(r.lockUntil) || 0,
        locked: Boolean(r.lockUntil && Number(r.lockUntil) > now),
        lastFailAt: Number(r.lastFailAt) || 0,
      }));
    } catch {
      lockouts = [];
    }

    const settings = await getSettings().catch(() => null);
    const store = await cookies();
    const session = await getDashboardAuthSession(store.get("auth_token")?.value || null);
    return NextResponse.json({
      encryption,
      lockouts,
      sessions: {
        tokenVersion: getTokenVersion(settings),
        currentTokenIssuedAt: session?.iat ? new Date(session.iat * 1000).toISOString() : null,
        currentTokenExpiresAt: session?.exp ? new Date(session.exp * 1000).toISOString() : null,
        note: "Dashboard sessions are stateless JWTs sharing one token epoch. Revoking bumps the epoch and invalidates every session except a freshly re-issued one.",
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}

// POST /api/admin/security { action: "unlock", ip } — clear one IP's login
// lockout (reuses loginLimiter.recordSuccess, which deletes the entry).
// The dashboard login route never consults the spam blacklist, so this
// can never lock the admin out; unlocking is itself logged.
export async function POST(request) {
  try {
    if (!(await requireDashboardAuth())) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const body = await request.json().catch(() => ({}));
    if (body?.action !== "unlock" || typeof body?.ip !== "string" || !body.ip.trim()) {
      return NextResponse.json({ error: "action=unlock with an ip is required" }, { status: 400 });
    }
    recordSuccess(body.ip.trim());
    await logAdminEvent("admin-lockout-unlocked", `Login lockout cleared for ${body.ip.trim()}`);
    return NextResponse.json({ success: true, ip: body.ip.trim() });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}
