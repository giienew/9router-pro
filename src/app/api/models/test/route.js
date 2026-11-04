import { NextResponse } from "next/server";
import { pingModelByKind } from "./ping";
import { classifyTestError } from "@/shared/utils/testErrorStage.js";

// POST /api/models/test - Ping a single model via internal completions or embeddings
export async function POST(request) {
  try {
    const { model, kind } = await request.json();
    if (!model) return NextResponse.json({ error: "Model required" }, { status: 400 });
    const result = await pingModelByKind(model, kind || "llm");
    // Ping does not classify: attach the stage here so every model test
    // result carries its real cause (auth/model/rate_limit/upstream/
    // network/proxy/timeout) instead of a bare ok/error.
    result.stage = result.ok
      ? "ok"
      : result.stage || classifyTestError({ status: result.status, error: result.error }).stage;
    return NextResponse.json(result);
  } catch (err) {
    // A ping abort (15s) is the TEST giving up, not proof the provider is
    // dead: the router's own request keeps running server-side and may fail
    // later with its own error (e.g. a ~250s connect timeout). Say so.
    const isTimeout = err?.name === "TimeoutError" || /timed out|timeout/i.test(err?.message || "");
    return NextResponse.json({
      ok: false,
      stage: isTimeout ? "timeout" : classifyTestError({ error: err.message }).stage,
      error: isTimeout
        ? "Test timed out after 15s — the provider may simply be slow; this is not proof the model is dead."
        : err.message,
    }, { status: 500 });
  }
}
