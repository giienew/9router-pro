import { NextResponse } from "next/server";
import { compressMessages } from "open-sse/rtk/index.js";

// POST /api/token-saver/test { text } — Test Bench (9Router Pro): run
// the exact RTK pipeline a chat request would hit, on one pasted tool
// output, and report what it would save. No upstream is called.
const MAX_TEXT = 2 * 1024 * 1024;

export async function POST(request) {
  try {
    const { text } = (await request.json()) || {};
    if (typeof text !== "string" || text.length === 0) {
      return NextResponse.json({ error: "Provide text to compress" }, { status: 400 });
    }
    if (text.length > MAX_TEXT) {
      return NextResponse.json({ error: "Text too large (max 2 MB)" }, { status: 400 });
    }
    const body = { messages: [{ role: "tool", content: text }] };
    const stats = compressMessages(body, true);
    const output = body.messages[0].content;
    const before = text.length;
    const after = output.length;
    const est = (n) => Math.ceil(n / 4);
    return NextResponse.json({
      applied: Boolean(stats && stats.hits && stats.hits.length > 0),
      filters: stats ? [...new Set(stats.hits.map((h) => h.filter))] : [],
      hits: stats ? stats.hits.length : 0,
      before: { chars: before, tokens: est(before) },
      after: { chars: after, tokens: est(after) },
      saved: { chars: before - after, tokens: est(before) - est(after) },
      savedPct: before > 0 ? Math.round(((before - after) / before) * 1000) / 10 : 0,
      output,
    });
  } catch (error) {
    console.log("Error in token saver test bench:", error);
    return NextResponse.json({ error: "Test failed" }, { status: 500 });
  }
}
