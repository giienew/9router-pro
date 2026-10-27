import { NextResponse } from "next/server";
import { sendNotification } from "@/lib/notify.js";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const results = await sendNotification("test", { title: "Test notification from 9Router Pro" });
    return NextResponse.json({ results });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}
