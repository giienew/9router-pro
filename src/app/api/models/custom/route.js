import { NextResponse } from "next/server";
import { getCustomModels, addCustomModel, deleteCustomModel } from "@/models";
import { CAPACITY_META, isSttTransport, sanitizeModelCapsOverride } from "@/shared/constants/models";

export const dynamic = "force-dynamic";

// Whitelist capability keys to boolean values — ignore anything else
function sanitizeCaps(caps) {
  if (!caps || typeof caps !== "object") return null;
  const clean = {};
  for (const key of Object.keys(CAPACITY_META)) {
    if (typeof caps[key] === "boolean") clean[key] = caps[key];
  }
  return Object.keys(clean).length ? clean : null;
}

// Accepted STT transport markers live in the shared whitelist
// (src/shared/constants/models STT_TRANSPORT_META) — the dashboard transport
// select and this validator must agree on one set, so neither owns a copy.
// Unknown or mistyped values are silently dropped, the same policy
// sanitizeCaps applies to capability keys.
function sanitizeTransport(transport, type) {
  if (type !== "stt" || !isSttTransport(transport)) return null;
  return transport.trim();
}

// GET /api/models/custom - List all custom models
export async function GET() {
  try {
    const models = await getCustomModels();
    return NextResponse.json({ models });
  } catch (error) {
    console.log("Error fetching custom models:", error);
    return NextResponse.json({ error: "Failed to fetch custom models" }, { status: 500 });
  }
}

// POST /api/models/custom - Add custom model
export async function POST(request) {
  try {
    const { providerAlias, id, type, name, caps, capsOverride, transport } = await request.json();
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    const cleanCaps = sanitizeCaps(caps);
    // The model editor writes the sparse override (only fields the user set);
    // the legacy add flow still sends `caps` (vision/reasoning only).
    const cleanOverride = sanitizeModelCapsOverride(capsOverride);
    const cleanTransport = sanitizeTransport(transport, type || "llm");
    const added = await addCustomModel({ providerAlias, id, type: type || "llm", name, ...(cleanCaps ? { caps: cleanCaps } : {}), ...(cleanOverride !== null ? { capsOverride: cleanOverride } : {}), ...(cleanTransport ? { transport: cleanTransport } : {}) });
    return NextResponse.json({ success: true, added });
  } catch (error) {
    console.log("Error adding custom model:", error);
    return NextResponse.json({ error: "Failed to add custom model" }, { status: 500 });
  }
}

// PATCH /api/models/custom - Edit a custom model / model override.
// Upsert: editing a detected (registry) model creates its override row, so
// the editor works on every row the Providers page lists, not just on
// user-added models. Sending `capsOverride: {}` clears the override (all
// Auto = detection). Only the fields present in the body change; anything
// omitted keeps its stored value.
export async function PATCH(request) {
  try {
    const body = await request.json();
    const { providerAlias, id, type, name, capsOverride } = body || {};
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    if (capsOverride === undefined && name === undefined) {
      return NextResponse.json({ error: "capsOverride or name required" }, { status: 400 });
    }
    const cleanOverride = capsOverride === undefined ? undefined : sanitizeModelCapsOverride(capsOverride);
    if (capsOverride !== undefined && cleanOverride === null) {
      return NextResponse.json({ error: "capsOverride must be an object" }, { status: 400 });
    }
    const added = await addCustomModel({ providerAlias, id, type: type || "llm", ...(name ? { name } : {}), ...(cleanOverride !== undefined ? { capsOverride: cleanOverride } : {}) });
    return NextResponse.json({ success: true, added });
  } catch (error) {
    console.log("Error updating custom model:", error);
    return NextResponse.json({ error: "Failed to update custom model" }, { status: 500 });
  }
}

// DELETE /api/models/custom?providerAlias=xxx&id=yyy&type=zzz
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const providerAlias = searchParams.get("providerAlias");
    const id = searchParams.get("id");
    const type = searchParams.get("type") || "llm";
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    await deleteCustomModel({ providerAlias, id, type });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting custom model:", error);
    return NextResponse.json({ error: "Failed to delete custom model" }, { status: 500 });
  }
}
