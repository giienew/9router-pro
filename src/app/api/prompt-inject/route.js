import { NextResponse } from "next/server";
import { getPromptProfiles, getPromptBindings, setPromptBindings } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// GET /api/prompt-inject - Prompt Inject state: profiles + bindings
export async function GET() {
  try {
    const [profiles, bindings] = await Promise.all([
      getPromptProfiles(),
      getPromptBindings(),
    ]);
    return NextResponse.json({ profiles, bindings });
  } catch (error) {
    console.log("Error fetching prompt inject state:", error);
    return NextResponse.json({ error: "Failed to fetch prompt inject state" }, { status: 500 });
  }
}

// PUT /api/prompt-inject - Replace bindings { global, byKey, byModel }
export async function PUT(request) {
  try {
    const body = await request.json();
    const bindings = body?.bindings ?? body;
    if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
      return NextResponse.json({ error: "Bindings object is required" }, { status: 400 });
    }
    const saved = await setPromptBindings(bindings);
    return NextResponse.json({ bindings: saved });
  } catch (error) {
    console.log("Error saving prompt bindings:", error);
    return NextResponse.json({ error: "Failed to save prompt bindings" }, { status: 500 });
  }
}
