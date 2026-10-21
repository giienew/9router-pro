import { NextResponse } from "next/server";
import {
  getInjectModelPrompts, getInjectUserPrompts, getInjectGlobal,
  setInjectModelPrompt, setInjectUserPrompt, setInjectGlobal,
  deleteInjectModelPrompt, deleteInjectUserPrompt,
  getPromptPresets, upsertPromptPreset, deletePromptPreset,
} from "@/lib/localDb";
import { selectPromptInjections } from "@/lib/db/repos/promptInjectRepo.js";

// Prompt Injection (9Router Pro) — reusable presets with targets, plus one
// direct injection per target: global, per user (API key), per model. Each
// entry is either a single system prompt or a scripted chat (turns).
// GET    /api/prompt-injection             → { global, userPrompts, prompts, presets }
// PUT    /api/prompt-injection             → { global: entry|null }
//                                          | { preset: {...} }  (upsert; id optional)
//                                          | { keyId, mode, content|turns, position, enabled }
//                                          | { model, mode, content|turns, position, enabled }
// DELETE /api/prompt-injection?model=<name>  |  ?keyId=<id>  |  ?presetId=<id>

export async function GET(request) {
  try {
    const [global, userPrompts, prompts, presets] = await Promise.all([
      getInjectGlobal(),
      getInjectUserPrompts(),
      getInjectModelPrompts(),
      getPromptPresets(),
    ]);
    // Stack preview: exactly what one request would receive, in order.
    const params = new URL(request.url).searchParams;
    if (params.get("preview")) {
      const model = params.get("model") || "";
      const stack = selectPromptInjections(
        { global, byKey: userPrompts, byModel: prompts, presets },
        {
          apiKeyId: params.get("keyId") || null,
          requestedModel: model,
          resolvedModel: model,
          bareModel: model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model,
        }
      );
      return NextResponse.json({ stack });
    }
    return NextResponse.json({ global, userPrompts, prompts, presets });
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
    if (body.preset && typeof body.preset === "object") {
      const saved = await upsertPromptPreset(body.preset);
      if (!saved) {
        return NextResponse.json(
          { error: "Preset needs a name and a non-empty prompt" },
          { status: 400 }
        );
      }
      return NextResponse.json({ preset: saved });
    }
    if (typeof body.keyId === "string" && body.keyId) {
      const saved = await setInjectUserPrompt(body.keyId, body);
      return NextResponse.json({ keyId: body.keyId, entry: saved });
    }
    if (typeof body.model === "string" && body.model) {
      const saved = await setInjectModelPrompt(body.model, body);
      return NextResponse.json({ model: body.model, entry: saved });
    }
    return NextResponse.json({ error: "Provide global, preset, keyId, or model" }, { status: 400 });
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
    const presetId = params.get("presetId");
    if (presetId) return NextResponse.json({ deleted: await deletePromptPreset(presetId) });
    if (model) return NextResponse.json({ deleted: await deleteInjectModelPrompt(model) });
    if (keyId) return NextResponse.json({ deleted: await deleteInjectUserPrompt(keyId) });
    return NextResponse.json({ error: "Provide model, keyId, or presetId" }, { status: 400 });
  } catch (error) {
    console.log("Error deleting prompt injection:", error);
    return NextResponse.json({ error: "Failed to delete prompt injection" }, { status: 500 });
  }
}
