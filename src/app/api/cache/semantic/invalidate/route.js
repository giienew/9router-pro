import { NextResponse } from "next/server";
import { isAuthenticated } from "@/dashboardGuard";
import { getAdapter } from "@/lib/db/driver.js";
import { invalidateSemanticEntries } from "@/lib/semanticCache.js";

export const dynamic = "force-dynamic";

// POST /api/cache/semantic/invalidate — clear the semantic (similar-prompt)
// cache. Dashboard-authenticated. Body: { model?: string } — when a model
// is given, only that model's entries are cleared; otherwise the whole
// semantic cache is cleared. Returns the number of entries removed.
export async function POST(request) {
  try {
    if (!(await isAuthenticated(request))) {
      return NextResponse.json({ error: "Dashboard authentication required" }, { status: 401 });
    }
    let model = null;
    try {
      const body = await request.json();
      if (typeof body?.model === "string" && body.model.trim()) model = body.model.trim();
    } catch { /* empty or unparsable body: invalidate all */ }
    const db = await getAdapter();
    const removed = invalidateSemanticEntries(db, model);
    return NextResponse.json({ removed, model: model || null });
  } catch (error) {
    console.log("Error invalidating semantic cache:", error);
    return NextResponse.json({ error: "Failed to invalidate semantic cache" }, { status: 500 });
  }
}
