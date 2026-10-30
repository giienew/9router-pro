import { NextResponse } from "next/server";
import { getNotifyConfig, saveNotifyConfig, normalizeNotifyConfig } from "@/lib/notify.js";
import { normalizeWebhookEventsConfig, WEBHOOK_EVENT_TYPES } from "@/lib/webhookEvents.js";

export const dynamic = "force-dynamic";

// GET /api/settings/webhook-events — flags only, never secrets.
// Dashboard-authenticated like the other settings routes (the dashboard
// session middleware gates /api/settings/*); the response contains no
// webhook URL or secret, only which event types are on.
export async function GET() {
  try {
    const cfg = await getNotifyConfig();
    return NextResponse.json({
      webhookEnabled: cfg.webhook.enabled === true,
      webhookConfigured: Boolean(cfg.webhook.url),
      events: normalizeWebhookEventsConfig(cfg.webhookEvents),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}

// POST /api/settings/webhook-events — { events: { usage, quota, error, maskCredentials } }.
// Only the event flags change; the webhook URL/secret and Telegram config
// are preserved from the stored config. Enabling an event here does
// nothing on its own unless the master webhook is also enabled and has
// a URL (see GET's webhookEnabled/webhookConfigured).
export async function POST(request) {
  try {
    const raw = await request.json().catch(() => ({}));
    if (!raw || typeof raw.events !== "object" || Array.isArray(raw.events)) {
      return NextResponse.json({ error: "events object required" }, { status: 400 });
    }
    const events = normalizeWebhookEventsConfig(raw.events);
    for (const k of Object.keys(raw.events)) {
      if (![...WEBHOOK_EVENT_TYPES, "maskCredentials"].includes(k)) {
        return NextResponse.json({ error: `unknown event flag: ${k}` }, { status: 400 });
      }
    }
    const existing = await getNotifyConfig();
    const next = normalizeNotifyConfig({
      telegram: existing.telegram,
      webhook: existing.webhook,
      webhookEvents: events,
    });
    await saveNotifyConfig(next);
    return NextResponse.json({
      webhookEnabled: next.webhook.enabled === true,
      webhookConfigured: Boolean(next.webhook.url),
      events,
    });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}
