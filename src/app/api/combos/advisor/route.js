import { NextResponse } from "next/server";
import { getCombos, createCombo, getComboByName } from "@/lib/localDb";
import { buildAdvisorCandidates, buildAdvisorDraft, previewAdvisorDraft } from "@/lib/comboAdvisorServer.js";

export const dynamic = "force-dynamic";

const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

// GET /api/combos/advisor?mode=free|tiered&probe=1 — dry-run draft only.
// Nothing is created by a GET; creation needs POST with apply:true.
export async function GET(request) {
  try {
    const params = new URL(request.url).searchParams;
    const mode = params.get("mode") === "tiered" ? "tiered" : "free";
    const probe = params.get("probe") === "1";
    const { candidates, probed, providers } = await buildAdvisorCandidates({ probe });
    const existingCombos = await getCombos();
    const proposedName = mode === "tiered" ? "advisor-tiered" : "free-stack";
    const { draft, preview } = previewAdvisorDraft({ candidates, mode, existingCombos, proposedName });
    return NextResponse.json({ mode, draft, preview, probed, providers, candidateCount: candidates.length }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}

// POST /api/combos/advisor — dry-run is the default. Pass apply:true
// (with an explicit name) to actually create the combo; a holding combo
// for rate-limited models is created only when applyHolding:true.
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const mode = body.mode === "tiered" ? "tiered" : "free";
    const name = typeof body.name === "string" ? body.name.trim() : (mode === "tiered" ? "advisor-tiered" : "free-stack");
    if (!VALID_NAME_REGEX.test(name)) return NextResponse.json({ error: "Invalid combo name" }, { status: 400 });
    const { candidates } = await buildAdvisorCandidates({ probe: false });
    const existingCombos = await getCombos();
    const draft = buildAdvisorDraft(candidates, mode);
    const preview = { proposedName: name, members: draft.members, holding: draft.holding || [], tiers: draft.tiers || null, wouldCreate: !(await getComboByName(name)) };
    if (!body.apply) return NextResponse.json({ dryRun: true, draft, preview });
    if (preview.wouldCreate === false) return NextResponse.json({ error: "Combo name already exists", preview }, { status: 409 });
    if (!draft.members.length) return NextResponse.json({ error: "No healthy candidates to build from", preview }, { status: 400 });
    const created = await createCombo({ name, models: draft.members, kind: null });
    let holding = null;
    if (body.applyHolding && (draft.holding || []).length) {
      const holdingName = `${name}-holding`;
      if (!(await getComboByName(holdingName))) holding = await createCombo({ name: holdingName, models: draft.holding, kind: null });
    }
    return NextResponse.json({ dryRun: false, created, holding, preview }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "failed" }, { status: 500 });
  }
}
