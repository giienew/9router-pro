import { NextResponse } from "next/server";
import {
  getInjectModelPrompts, getInjectUserPrompts, getInjectGlobal,
  setInjectModelPrompt, setInjectUserPrompt, setInjectGlobal,
  deleteInjectModelPrompt, deleteInjectUserPrompt,
} from "@/lib/localDb";

// Prompt Injection (9Router Pro) — one global injection, one per user
// (API key), one per model. Each entry is either a single system prompt
// or a scripted chat (turns). Flat: every target owns exactly one entry.
// GET    /api/prompt-injection             → { global, userPrompts, prompts }
// PUT    /api/prompt-injection             → { global: entry|null }
//                                          | { keyId, mode, content|turns, position, enabled }
//                                          | { model, mode, content|turns, position, enabled }
// DELETE /api/prompt-injection?model=<name>  |  ?keyId=<id>

export async function GET() {
  try {
    const [global, userPrompts, prompts] = await Promise.all([
      getInjectGlobal(),
      getInjectUserPrompts(),
      getInjectModelPrompts(),
    ]);
    return NextResponse.json({ global, userPrompts, prompts });
  } catch (error) {
    console.log("Error fetching prompt injections:", error);
    return NextResponse.json({ error: "Failed to fetch prompt injections" }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const body = (await request.json()) || {};
    if ("global" in body) {
      const saved = await setInjectGlobal(body.global || {});
      return NextResponse.json({ global: saved });
    }
    if (typeof body.keyId === "string" && body.keyId) {
      const saved = await setInjectUserPrompt(body.keyId, body);
      return NextResponse.json({ keyId: body.keyId, entry: saved });
    }
    if (typeof body.model === "string" && body.model) {
      const saved = await setInjectModelPrompt(body.model, body);
      return NextResponse.json({ model: body.model, entry: saved });
    }
    return NextResponse.json({ error: "Provide global, keyId, or model" }, { status: 400 });
  } catch (error) {
    console.log("Error saving prompt injection:", error);
    return NextResponse.json({ error: "Failed to save prompt injection" }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const params = new URL(request.url).searchParams;
    const model = params.get("model");
    const keyId = params.get("keyId");
    if (model) return NextResponse.json({ deleted: await deleteInjectModelPrompt(model) });
    if (keyId) return NextResponse.json({ deleted: await deleteInjectUserPrompt(keyId) });
    return NextResponse.json({ error: "Provide model or keyId" }, { status: 400 });
  } catch (error) {
    console.log("Error deleting prompt injection:", error);
    return NextResponse.json({ error: "Failed to delete prompt injection" }, { status: 500 });
  }
}
