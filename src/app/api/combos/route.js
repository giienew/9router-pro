import { NextResponse } from "next/server";
import { getCombos, createCombo, getComboByName, normalizeRoutableMembers, getInjectVariants, getModelAliases } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// Validate combo name: only a-z, A-Z, 0-9, -, _
const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

// Kinds a combo can carry: null/"llm" (Combos page) + the media kinds
// (MEDIA_PROVIDER_KINDS + WEB_KIND_CONFIGS). Anything else renders in
// no menu at all, so it is rejected instead of stored (opt20 m5).
const ALLOWED_KINDS = new Set([null, "llm", "embedding", "image", "imageToText", "tts", "stt", "video", "music", "systemone", "webSearch", "webFetch"]);

// GET /api/combos - Get all combos
export async function GET() {
  try {
    const combos = await getCombos();
    return NextResponse.json({ combos });
  } catch (error) {
    console.log("Error fetching combos:", error);
    return NextResponse.json({ error: "Failed to fetch combos" }, { status: 500 });
  }
}

// POST /api/combos - Create new combo
export async function POST(request) {
  try {
    const body = await request.json();
    const { name, models, kind } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    // Validate name format
    if (!VALID_NAME_REGEX.test(name)) {
      return NextResponse.json({ error: "Name can only contain letters, numbers, -, _ and ." }, { status: 400 });
    }

    // Check if name already exists
    const existing = await getComboByName(name);
    if (existing) {
      return NextResponse.json({ error: "Combo name already exists" }, { status: 400 });
    }

    // A combo name must not shadow a variant or a model alias: dispatch
    // checks combos first, so a colliding combo would silently hijack
    // that route (opt20 M4; mirrors the variant-side guard).
    const variants = await getInjectVariants().catch(() => ({}));
    if (variants && typeof variants === "object" && name in variants) {
      return NextResponse.json({ error: "Combo name is already used by a variant" }, { status: 409 });
    }
    const aliases = await getModelAliases().catch(() => ({}));
    if (aliases && typeof aliases === "object" && name in aliases) {
      return NextResponse.json({ error: "Combo name is already used by a model alias" }, { status: 409 });
    }

    // Members must be a non-empty array: a string would store as a
    // string and crash ComboCard (.map), an empty list resolves to null
    // at request time with no clear error (opt20 m2).
    const memberList = models ?? [];
    if (!Array.isArray(memberList)) {
      return NextResponse.json({ error: "models must be an array" }, { status: 400 });
    }
    if (memberList.length === 0) {
      return NextResponse.json({ error: "At least one member is required" }, { status: 400 });
    }

    // Kind must be one a menu actually lists (opt20 m5).
    if (!ALLOWED_KINDS.has(kind ?? null)) {
      return NextResponse.json({ error: "Invalid kind" }, { status: 400 });
    }

    const combo = await createCombo({ name, models: await normalizeRoutableMembers(memberList), kind: kind || null });

    return NextResponse.json(combo, { status: 201 });
  } catch (error) {
    console.log("Error creating combo:", error);
    // Race backstop for the DB unique indexes (opt20 m1, same pattern
    // as opt13 for apiKeys): a duplicate that slipped past the app
    // checks must 400, not 500.
    const msg = String(error?.message || "");
    if (/UNIQUE constraint failed/.test(msg)) {
      return NextResponse.json({ error: "Combo name already exists" }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to create combo" }, { status: 500 });
  }
}
