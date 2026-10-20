import { NextResponse } from "next/server";
import {
  getSoulPrompts, getSoulUserPrompts, getSoulGlobal,
  setSoulPrompt, setSoulUserPrompt, setSoulGlobal,
  deleteSoulPrompt, deleteSoulUserPrompt,
} from "@/lib/localDb";

// Soul Prompts (9Router Pro) — one global soul, one soul per user (API key),
// one soul per model. Flat: every target owns exactly one prompt.
// GET    /api/soul-prompts                 → { global, userPrompts, prompts }
// PUT    /api/soul-prompts                 → { global: entry|null }
//                                          | { keyId, content, position, enabled }
//                                          | { model, content, position, enabled }
// DELETE /api/soul-prompts?model=<name>  |  ?keyId=<id>

export async function GET() {
  try {
    const [global, userPrompts, prompts] = await Promise.all([
      getSoulGlobal(),
      getSoulUserPrompts(),
      getSoulPrompts(),
    ]);
    return NextResponse.json({ global, userPrompts, prompts });
  } catch (error) {
    console.log("Error fetching soul prompts:", error);
    return NextResponse.json({ error: "Failed to fetch soul prompts" }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const body = (await request.json()) || {};
    if ("global" in body) {
      const saved = await setSoulGlobal(body.global || {});
      return NextResponse.json({ global: saved });
    }
    if (typeof body.keyId === "string" && body.keyId) {
      const saved = await setSoulUserPrompt(body.keyId, body);
      return NextResponse.json({ keyId: body.keyId, entry: saved });
    }
    if (typeof body.model === "string" && body.model) {
      const saved = await setSoulPrompt(body.model, body);
      return NextResponse.json({ model: body.model, entry: saved });
    }
    return NextResponse.json({ error: "Provide global, keyId, or model" }, { status: 400 });
  } catch (error) {
    console.log("Error saving soul prompt:", error);
    return NextResponse.json({ error: "Failed to save soul prompt" }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const params = new URL(request.url).searchParams;
    const model = params.get("model");
    const keyId = params.get("keyId");
    if (model) return NextResponse.json({ deleted: await deleteSoulPrompt(model) });
    if (keyId) return NextResponse.json({ deleted: await deleteSoulUserPrompt(keyId) });
    return NextResponse.json({ error: "Provide model or keyId" }, { status: 400 });
  } catch (error) {
    console.log("Error deleting soul prompt:", error);
    return NextResponse.json({ error: "Failed to delete soul prompt" }, { status: 500 });
  }
}
