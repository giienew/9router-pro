import { NextResponse } from "next/server";
import { getComboById, getApiKeys, getModelAliases } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// GET /api/combos/[id]/references - read-only reference counts for the
// delete-impact preview (opt20 m6). Returns names only, never key
// values or prompt contents: restricted keys whose allow list contains
// the combo name, and model aliases pointing at it. (A default model
// set by an external consumer, e.g. Hermes, lives outside this router
// and is not countable here; no pairs store exists router-side.)
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const combo = await getComboById(id);

    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    const keys = [];
    try {
      const apiKeys = await getApiKeys();
      for (const k of apiKeys || []) {
        const allow = k?.access?.allow;
        if (k?.access?.restricted && Array.isArray(allow) && allow.includes(combo.name)) keys.push(k.name);
      }
    } catch {}

    const aliases = [];
    try {
      const map = await getModelAliases();
      for (const [alias, model] of Object.entries(map || {})) {
        if (model === combo.name) aliases.push(alias);
      }
    } catch {}

    return NextResponse.json({ name: combo.name, references: { keys, aliases } });
  } catch (error) {
    console.log("Error fetching combo references:", error);
    return NextResponse.json({ error: "Failed to fetch combo references" }, { status: 500 });
  }
}
