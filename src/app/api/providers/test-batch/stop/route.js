import { NextResponse } from "next/server";
import { stopBatchJob } from "@/lib/batchTestRegistry";

// POST /api/providers/test-batch/stop - Ask a running batch test to stop.
// The batch request itself stays open and returns its partial results with
// stopped: true, so the UI can report how far it got.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  if (!body.jobId || typeof body.jobId !== "string") {
    return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, found: stopBatchJob(body.jobId) });
}
