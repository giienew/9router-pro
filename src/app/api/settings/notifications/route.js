import { NextResponse } from "next/server";
import { getNotifyStatus, getNotifyConfig, saveNotifyConfig, normalizeNotifyConfig } from "@/lib/notify.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getNotifyStatus(), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const raw = await request.json();
    const cfg = normalizeNotifyConfig(raw);
    // Secrets are never returned by GET, so a blank field means "keep the
    // stored one" — otherwise every save would wipe the token.
    const existing = await getNotifyConfig();
    // Same keep rule for structured webhook events: the legacy Automation
    // form does not send webhookEvents, and normalizing it blind would
    // silently switch every event off on every save.
    if (raw?.webhookEvents === undefined && existing.webhookEvents) {
      cfg.webhookEvents = existing.webhookEvents;
    }
    if (!cfg.telegram.botToken) cfg.telegram.botToken = existing.telegram.botToken;
    if (!cfg.webhook.secret) cfg.webhook.secret = existing.webhook.secret;
    if (cfg.telegram.enabled && (!cfg.telegram.botToken || !cfg.telegram.chatId)) {
      return NextResponse.json({ error: "Telegram needs a bot token and a chat id" }, { status: 400 });
    }
    if (cfg.webhook.enabled) {
      try {
        const u = new URL(cfg.webhook.url);
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad protocol");
      } catch {
        return NextResponse.json({ error: "Webhook needs a valid http(s) URL" }, { status: 400 });
      }
    }
    await saveNotifyConfig(cfg);
    return NextResponse.json(await getNotifyStatus());
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}
