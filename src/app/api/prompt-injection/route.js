import { NextResponse } from "next/server";
import {
  getInjectModelPrompts, getInjectUserPrompts, getInjectGlobal, getInjectKeyModelPrompts,
  setInjectModelPrompt, setInjectUserPrompt, setInjectGlobal, setInjectKeyModelPrompt,
  deleteInjectModelPrompt, deleteInjectUserPrompt, deleteInjectKeyModelPrompt,
  getPromptTemplates, upsertPromptTemplate, deletePromptTemplate,
} from "@/lib/localDb";
import { selectPromptInjections } from "@/lib/db/repos/promptInjectRepo.js";

// Prompt Injection (9Router Pro) — one injection per target coordinate:
// global, per API key, per model, or per model+key — plus a template
// library (named prompts, copied into injections; never fired directly).
// Each entry is either a single system prompt or a scripted chat (turns).
// GET    /api/prompt-injection             → { global, userPrompts, prompts, keyModelPrompts, templates }
// GET    /api/prompt-injection?preview=1&model=<name>&keyId=<id> → { stack }
// PUT    /api/prompt-injection             → { global: entry|null }
//                                          | { template: {...} }  (upsert; id optional)
//                                          | { keyId, mode, content|turns, position, enabled, templateName? }
//                                          | { model, mode, content|turns, position, enabled, templateName? }
//                                          | { keyId, model, mode, ... }  (model+key coordinate)
// DELETE /api/prompt-injection?model=<name>           → model coordinate
//        /api/prompt-injection?keyId=<id>             → key coordinate
//        /api/prompt-injection?keyId=<id>&model=<n>   → model+key coordinate
//        /api/prompt-injection?templateId=<id>        → template

export async function GET(request) {
  try {
    const [global, userPrompts, prompts, keyModelPrompts, templates] = await Promise.all([
      getInjectGlobal(),
      getInjectUserPrompts(),
      getInjectModelPrompts(),
      getInjectKeyModelPrompts(),
      getPromptTemplates(),
    ]);
    // Stack preview: exactly what one request would receive, in order.
    const params = new URL(request.url).searchParams;
    if (params.get("preview")) {
      const model = params.get("model") || "";
      const stack = selectPromptInjections(
        { global, byKey: userPrompts, byModel: prompts, byKeyModel: keyModelPrompts },
        {
          apiKeyId: params.get("keyId") || null,
          requestedModel: model,
          resolvedModel: model,
          bareModel: model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model,
        }
      );
      return NextResponse.json({ stack });
    }
    return NextResponse.json({ global, userPrompts, prompts, keyModelPrompts, templates });
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
    if (body.template && typeof body.template === "object") {
      const saved = await upsertPromptTemplate(body.template);
      if (!saved) {
        return NextResponse.json(
          { error: "Template needs a name and a non-empty prompt" },
          { status: 400 }
        );
      }
      return NextResponse.json({ template: saved });
    }
    const hasKey = typeof body.keyId === "string" && !!body.keyId;
    const hasModel = typeof body.model === "string" && !!body.model;
    // Provider/model concept: a model target must be a concrete routed
    // model ("provider/model"). Combo names and bare ids never match, so
    // saving one would create an entry that silently never fires.
    if (hasModel && !body.model.includes("/")) {
      return NextResponse.json(
        { error: "Model target must be a provider/model (e.g. dahl/deepseek-ai/DeepSeek-V4-Flash-0731); combo names cannot be injection targets" },
        { status: 400 }
      );
    }
    if (hasKey && hasModel) {
      const saved = await setInjectKeyModelPrompt(body.keyId, body.model, body);
      return NextResponse.json({ keyId: body.keyId, model: body.model, entry: saved });
    }
    if (hasKey) {
      const saved = await setInjectUserPrompt(body.keyId, body);
      return NextResponse.json({ keyId: body.keyId, entry: saved });
    }
    if (hasModel) {
      const saved = await setInjectModelPrompt(body.model, body);
      return NextResponse.json({ model: body.model, entry: saved });
    }
    return NextResponse.json({ error: "Provide global, template, keyId, or model" }, { status: 400 });
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
    const templateId = params.get("templateId");
    if (templateId) return NextResponse.json({ deleted: await deletePromptTemplate(templateId) });
    if (model && keyId) return NextResponse.json({ deleted: await deleteInjectKeyModelPrompt(keyId, model) });
    if (model) return NextResponse.json({ deleted: await deleteInjectModelPrompt(model) });
    if (keyId) return NextResponse.json({ deleted: await deleteInjectUserPrompt(keyId) });
    return NextResponse.json({ error: "Provide model, keyId, or templateId" }, { status: 400 });
  } catch (error) {
    console.log("Error deleting prompt injection:", error);
    return NextResponse.json({ error: "Failed to delete prompt injection" }, { status: 500 });
  }
}
