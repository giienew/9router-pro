import { NextResponse } from "next/server";
import {
  getInjectModelPrompts, getInjectUserPrompts, getInjectGlobal, getInjectKeyModelPrompts,
  setInjectModelPrompt, setInjectUserPrompt, setInjectGlobal, setInjectKeyModelPrompt,
  deleteInjectModelPrompt, deleteInjectUserPrompt, deleteInjectKeyModelPrompt,
  getInjectVariants, setInjectVariant, deleteInjectVariant, migrateModelPromptsToVariants,
  getModelAliases,
  getPromptTemplates, upsertPromptTemplate, deletePromptTemplate,
} from "@/lib/localDb";
import { getComboByName } from "@/lib/db/repos/combosRepo.js";
import { selectPromptInjections } from "@/lib/db/repos/promptInjectRepo.js";

// Prompt Injection (9Router Pro) — one injection per target coordinate:
// global, per API key, per variant (custom-named model), or per model+key
// — plus a template library (named prompts, copied into injections; never
// fired directly). Each entry is either a single system prompt or a
// scripted chat (turns).
// A variant is a custom name backed by one provider/model: picking the
// variant serves that model WITH the prompt; picking the raw model serves
// it WITHOUT any prompt, so the original model name is never disturbed.
// Saving a variant creates/updates a single-member combo of the same name
// (that is how the name resolves to its backing model); deleting it
// removes that combo too.
// GET    /api/prompt-injection             → { global, userPrompts, prompts, keyModelPrompts, variants, templates }
// GET    /api/prompt-injection?preview=1&model=<name>&keyId=<id> → { stack }
// PUT    /api/prompt-injection             → { global: entry|null }
//                                          | { template: {...} }  (upsert; id optional)
//                                          | { keyId, mode, content|turns, position, enabled, templateName? }
//                                          | { variant: { name, model, mode, content|turns, position, enabled, templateName? } }
//                                          | { keyId, model, mode, ... }  (model+key coordinate)
// DELETE /api/prompt-injection?variant=<name>        → variant (+ its combo)
//        /api/prompt-injection?model=<name>           → model coordinate (legacy cleanup)
//        /api/prompt-injection?keyId=<id>             → key coordinate
//        /api/prompt-injection?keyId=<id>&model=<n>   → model+key coordinate
//        /api/prompt-injection?templateId=<id>        → template

export async function GET(request) {
  try {
    await migrateModelPromptsToVariants().catch(() => {});
    const [global, userPrompts, prompts, keyModelPrompts, variants, templates] = await Promise.all([
      getInjectGlobal(),
      getInjectUserPrompts(),
      getInjectModelPrompts(),
      getInjectKeyModelPrompts(),
      getInjectVariants(),
      getPromptTemplates(),
    ]);
    // Stack preview: exactly what one request would receive, in order.
    const params = new URL(request.url).searchParams;
    if (params.get("preview")) {
      const model = params.get("model") || "";
      const stack = selectPromptInjections(
        { global, byKey: userPrompts, byModel: prompts, byKeyModel: keyModelPrompts, byVariant: variants },
        {
          apiKeyId: params.get("keyId") || null,
          requestedModel: model,
          resolvedModel: model,
          bareModel: model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model,
        }
      );
      return NextResponse.json({ stack });
    }
    return NextResponse.json({ global, userPrompts, prompts, keyModelPrompts, variants, templates });
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
    // Variant: a custom name backed by one provider/model. The name is
    // the identity — it must not collide with an existing combo.
    if (body.variant && typeof body.variant === "object") {
      const v = body.variant;
      const name = typeof v.name === "string" ? v.name.trim() : "";
      if (!name || name.length > 80 || name.includes("/")) {
        return NextResponse.json(
          { error: "Variant needs a custom name without \"/\" and at most 80 characters (e.g. dahlunce)" },
          { status: 400 }
        );
      }
      if (typeof v.model !== "string" || !v.model.includes("/")) {
        return NextResponse.json(
          { error: "Variant needs a backing provider/model (e.g. dahl/deepseek-ai/DeepSeek-V4-Flash-0731)" },
          { status: 400 }
        );
      }
      const existing = (await getInjectVariants())[name];
      if (!existing && (await getComboByName(name).catch(() => null))) {
        return NextResponse.json(
          { error: `Nama "${name}" sudah dipakai combo — pilih nama lain` },
          { status: 400 }
        );
      }
      if (!existing) {
        const aliases = await getModelAliases().catch(() => ({}));
        if (aliases && typeof aliases === "object" && name in aliases) {
          return NextResponse.json(
            { error: `Nama "${name}" sudah dipakai alias model — pilih nama lain` },
            { status: 400 }
          );
        }
      }
      const saved = await setInjectVariant(name, v);
      if (!saved) {
        return NextResponse.json(
          { error: "Failed to save variant (name collision or invalid backing)" },
          { status: 400 }
        );
      }
      return NextResponse.json({ variant: saved });
    }
    // Model targets no longer exist: an injection must use a custom name
    // (variant) so the original model name is never disturbed.
    if (hasModel && !hasKey) {
      return NextResponse.json(
        { error: "Model targets are now variants — give the injection a custom name (variant) instead" },
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
    return NextResponse.json({ error: "Provide global, template, keyId, or variant" }, { status: 400 });
  } catch (error) {
    console.log("Error saving prompt injection:", error);
    return NextResponse.json({ error: "Failed to save prompt injection" }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const params = new URL(request.url).searchParams;
    const variant = params.get("variant");
    const model = params.get("model");
    const keyId = params.get("keyId");
    const templateId = params.get("templateId");
    if (templateId) return NextResponse.json({ deleted: await deletePromptTemplate(templateId) });
    if (variant) return NextResponse.json({ deleted: await deleteInjectVariant(variant) });
    if (model && keyId) return NextResponse.json({ deleted: await deleteInjectKeyModelPrompt(keyId, model) });
    if (model) return NextResponse.json({ deleted: await deleteInjectModelPrompt(model) });
    if (keyId) return NextResponse.json({ deleted: await deleteInjectUserPrompt(keyId) });
    return NextResponse.json({ error: "Provide variant, model, keyId, or templateId" }, { status: 400 });
  } catch (error) {
    console.log("Error deleting prompt injection:", error);
    return NextResponse.json({ error: "Failed to delete prompt injection" }, { status: 500 });
  }
}
