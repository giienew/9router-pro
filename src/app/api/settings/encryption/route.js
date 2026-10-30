import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { parseJson } from "@/lib/db/helpers/jsonCol.js";
import { isKeyConfigured, countRowEncryption, migrateConnectionsEncryption } from "@/lib/atRestCrypto.js";
import { verifyDashboardPassword } from "@/lib/auth/dashboardSession.js";

export const dynamic = "force-dynamic";

// GET /api/settings/encryption — status only (never the key, never values).
export async function GET() {
  try {
    const db = await getAdapter();
    const rows = db.all(`SELECT data FROM providerConnections`);
    let plaintext = 0;
    let encrypted = 0;
    let rowsWithPlaintext = 0;
    for (const row of rows) {
      const c = countRowEncryption(parseJson(row.data, {}));
      plaintext += c.plaintext;
      encrypted += c.encrypted;
      if (c.plaintext) rowsWithPlaintext++;
    }
    return NextResponse.json({
      keyConfigured: isKeyConfigured(),
      envVar: "PRO_CREDENTIAL_KEY",
      connections: rows.length,
      plaintextFields: plaintext,
      encryptedFields: encrypted,
      rowsWithPlaintext,
      note: "Set PRO_CREDENTIAL_KEY (32 bytes, hex or base64) before migrating; keep a copy of the key — encrypted rows need it to decrypt.",
    });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}

// POST /api/settings/encryption { action: "migrate"|"dry-run", password }
// Migration is explicit and dashboard-password-gated; dry-run counts only.
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (!(await verifyDashboardPassword(body.password))) {
      return NextResponse.json({ error: "Dashboard password required" }, { status: 401 });
    }
    if (body.action === "dry-run") return NextResponse.json(await migrateConnectionsEncryption({ dryRun: true }));
    if (body.action === "migrate") {
      if (!isKeyConfigured()) return NextResponse.json({ error: "PRO_CREDENTIAL_KEY is not set — refusing to migrate without a key" }, { status: 400 });
      return NextResponse.json(await migrateConnectionsEncryption({ dryRun: false }));
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}
