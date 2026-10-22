import { NextResponse } from "next/server";
import { getProxyHealthJobState, startProxyHealthJob } from "@/lib/network/proxyHealthJob";

// GET /api/proxy-pools/test-all - progress of the bulk health-check job
export async function GET() {
  return NextResponse.json(getProxyHealthJobState());
}

// POST /api/proxy-pools/test-all - start the job (optionally for selected ids)
// Body: { ids?: string[] } — omitted/empty means every pool.
export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    // an empty body means "test everything"
  }
  const ids = Array.isArray(body?.ids) ? body.ids.filter((id) => typeof id === "string") : undefined;
  const state = await startProxyHealthJob(ids);
  return NextResponse.json(state);
}
