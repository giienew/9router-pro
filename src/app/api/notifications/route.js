import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import {
  listTrustEvents, trustUnreadCount, markTrustEventRead,
  markAllTrustEventsRead, recordTrustEvent, clearTrustSubject,
} from "@/lib/trustEvents.js";

export const dynamic = "force-dynamic";

// GET /api/notifications — persistent trust inbox (R2). Transient toasts
// stay as-is; this is the durable list the bell reads.
export async function GET(request) {
  try {
    const db = await getAdapter();
    const unreadOnly = new URL(request.url).searchParams.get("unread") === "1";
    const events = listTrustEvents(db, { unreadOnly });
    return NextResponse.json({ events, unread: trustUnreadCount(db) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const db = await getAdapter();
    if (body.action === "read" && body.id != null) {
      return NextResponse.json({ ok: markTrustEventRead(db, body.id) });
    }
    if (body.action === "read-all") {
      return NextResponse.json({ ok: true, cleared: markAllTrustEventsRead(db) });
    }
    if (body.action === "clear-subject" && body.kind && body.subject) {
      return NextResponse.json({ ok: true, cleared: clearTrustSubject(db, body.kind, body.subject) });
    }
    // Generic event intake for dashboard-side producers (quota checks,
    // long jobs): deduped by recordTrustEvent, never a free-form spam hole
    // for arbitrary kinds — only the known inbox kinds are accepted.
    if (body.action === "event" && ["quota", "failed-request", "security", "job"].includes(body.kind) && body.title) {
      const id = recordTrustEvent(db, { kind: body.kind, level: body.level || "info", subject: body.subject || null, title: String(body.title).slice(0, 200), detail: body.detail ? String(body.detail).slice(0, 500) : null });
      return NextResponse.json({ ok: id != null, id });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}
