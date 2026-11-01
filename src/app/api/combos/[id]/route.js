import { NextResponse } from "next/server";
import { getComboById, updateCombo, deleteCombo, getComboByName, normalizeRoutableMembers, getInjectVariants, getModelAliases } from "@/lib/localDb";
import { resetComboRotation } from "open-sse/services/combo.js";

// Validate combo name: only a-z, A-Z, 0-9, -, _
const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

// Kinds a combo can carry: null/"llm" (Combos page) + the media kinds
// (MEDIA_PROVIDER_KINDS + WEB_KIND_CONFIGS). Anything else renders in
// no menu at all, so it is rejected instead of stored (opt20 m5).
const ALLOWED_KINDS = new Set([null, "llm", "embedding", "image", "imageToText", "tts", "stt", "video", "music", "systemone", "webSearch", "webFetch"]);

// GET /api/combos/[id] - Get combo by ID
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const combo = await getComboById(id);
    
    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }
    
    return NextResponse.json(combo);
  } catch (error) {
    console.log("Error fetching combo:", error);
    return NextResponse.json({ error: "Failed to fetch combo" }, { status: 500 });
  }
}

// PUT /api/combos/[id] - Update combo
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    
    // Validate name format if provided
    if (body.name) {
      if (!VALID_NAME_REGEX.test(body.name)) {
        return NextResponse.json({ error: "Name can only contain letters, numbers, -, _ and ." }, { status: 400 });
      }
      
      // Check if name already exists (exclude current combo)
      const existing = await getComboByName(body.name);
      if (existing && existing.id !== id) {
        return NextResponse.json({ error: "Combo name already exists" }, { status: 400 });
      }

      // Must not shadow a variant or a model alias (opt20 M4; see POST).
      const variants = await getInjectVariants().catch(() => ({}));
      if (variants && typeof variants === "object" && body.name in variants) {
        return NextResponse.json({ error: "Combo name is already used by a variant" }, { status: 409 });
      }
      const aliases = await getModelAliases().catch(() => ({}));
      if (aliases && typeof aliases === "object" && body.name in aliases) {
        return NextResponse.json({ error: "Combo name is already used by a model alias" }, { status: 409 });
      }
    }

    // Members must be a non-empty array when supplied (opt20 m2).
    if (body.models !== undefined) {
      if (!Array.isArray(body.models)) {
        return NextResponse.json({ error: "models must be an array" }, { status: 400 });
      }
      if (body.models.length === 0) {
        return NextResponse.json({ error: "At least one member is required" }, { status: 400 });
      }
    }

    // Kind must be one a menu actually lists (opt20 m5).
    if (body.kind !== undefined && !ALLOWED_KINDS.has(body.kind ?? null)) {
      return NextResponse.json({ error: "Invalid kind" }, { status: 400 });
    }
    
    // Capture previous name to invalidate rotation state on rename
    const prev = await getComboById(id);
    const patch = Array.isArray(body.models)
      ? { ...body, models: await normalizeRoutableMembers(body.models) }
      : body;
    const combo = await updateCombo(id, patch);
    
    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    // Invalidate rotation state (models/strategy/name may have changed)
    if (prev?.name) resetComboRotation(prev.name);
    if (combo.name && combo.name !== prev?.name) resetComboRotation(combo.name);

    return NextResponse.json(combo);
  } catch (error) {
    console.log("Error updating combo:", error);
    // Race backstop for the DB unique indexes (opt20 m1, same pattern
    // as opt13 for apiKeys): a duplicate that slipped past the app
    // checks must 400, not 500.
    const msg = String(error?.message || "");
    if (/UNIQUE constraint failed/.test(msg)) {
      return NextResponse.json({ error: "Combo name already exists" }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to update combo" }, { status: 500 });
  }
}

// DELETE /api/combos/[id] - Delete combo
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const prev = await getComboById(id);
    const success = await deleteCombo(id);
    
    if (!success) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    if (prev?.name) resetComboRotation(prev.name);
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting combo:", error);
    return NextResponse.json({ error: "Failed to delete combo" }, { status: 500 });
  }
}
