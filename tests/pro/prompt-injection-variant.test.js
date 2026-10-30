// 9Router Pro — Prompt Injection variant tests (vitest).
// A variant is a custom-named model: picking the variant serves its
// backing provider/model WITH the prompt; picking the raw model serves
// it WITHOUT any prompt. Variant names route directly (dispatch checks
// the variants map), so no combo object is created per variant — the
// Kombinasi page shows only combos the user actually made. Runs against
// a throwaway DATA_DIR so the live database is never touched. Run from
// tests/:
//   bun x vitest run pro/prompt-injection-variant.test.js
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MODEL_A = "dahl/deepseek-ai/DeepSeek-V4-Flash-0731";
const MODEL_B = "dahl/zai-org/GLM-5.3-Flash";

let repo;
let combosRepo;
let tmpDir;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-variant-"));
  process.env.DATA_DIR = tmpDir;
  repo = await import("@/lib/db/repos/promptInjectRepo.js");
  combosRepo = await import("@/lib/db/repos/combosRepo.js");
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* throwaway dir */ }
});

describe("prompt injection variants", () => {
  it("saves a variant and creates no combo", async () => {
    const saved = await repo.setInjectVariant("dahlunce", {
      model: MODEL_A, mode: "single", content: "hello",
    });
    assert.ok(saved);
    assert.equal(saved.model, MODEL_A);
    assert.equal(saved.comboId, null);
    assert.equal(await combosRepo.getComboByName("dahlunce"), null);
    const map = await repo.getInjectVariants();
    assert.equal(map.dahlunce.model, MODEL_A);
  });

  it("rejects a variant name with a slash, a blank name, and a backing without a slash", async () => {
    assert.equal(await repo.setInjectVariant("a/b", { model: MODEL_A, mode: "single", content: "x" }), null);
    assert.equal(await repo.setInjectVariant("   ", { model: MODEL_A, mode: "single", content: "x" }), null);
    assert.equal(await repo.setInjectVariant("noname", { model: "bare-model", mode: "single", content: "x" }), null);
  });

  it("caps a variant name at 80 chars", async () => {
    const saved = await repo.setInjectVariant("v".repeat(200), { model: MODEL_A, mode: "single", content: "x" });
    assert.ok(saved);
    const map = await repo.getInjectVariants();
    assert.ok(Object.keys(map).some((k) => k.length === 80));
    await repo.deleteInjectVariant("v".repeat(80));
  });

  it("refuses a variant name already owned by another combo", async () => {
    await combosRepo.createCombo({ name: "taken", models: [MODEL_B] });
    assert.equal(await repo.setInjectVariant("taken", { model: MODEL_A, mode: "single", content: "x" }), null);
    await combosRepo.deleteCombo((await combosRepo.getComboByName("taken")).id);
  });

  it("changing the backing updates the entry, still no combo", async () => {
    const before = await repo.setInjectVariant("dahlunce", {
      model: MODEL_B, mode: "single", content: "hello",
    });
    assert.equal(before.model, MODEL_B);
    assert.equal(before.comboId, null);
    assert.equal(await combosRepo.getComboByName("dahlunce"), null);
  });

  it("deleting a variant removes only the entry and leaves real combos alone", async () => {
    await combosRepo.createCombo({ name: "real-combo", models: [MODEL_B] });
    await repo.setInjectVariant("todelete", { model: MODEL_A, mode: "single", content: "x" });
    assert.equal(await repo.deleteInjectVariant("todelete"), true);
    assert.equal((await repo.getInjectVariants()).todelete, undefined);
    assert.deepEqual((await combosRepo.getComboByName("real-combo")).models, [MODEL_B]);
    await combosRepo.deleteCombo((await combosRepo.getComboByName("real-combo")).id);
  });

  it("a variant pick injects, a raw pick does not, and a variant suppresses the model entry", async () => {
    await repo.setInjectModelPrompt(MODEL_A, { mode: "single", content: "raw-model-prompt" });
    const byVariant = await repo.getInjectVariants();
    const byModel = await repo.getInjectModelPrompts();
    // Variant pick: only the variant prompt.
    let found = repo.selectPromptInjections(
      { global: null, byKey: {}, byModel, byKeyModel: {}, byVariant },
      { apiKeyId: null, requestedModel: "dahlunce", resolvedModel: MODEL_A, bareModel: "DeepSeek-V4-Flash-0731" }
    );
    assert.deepEqual(found.map((f) => f.text), ["hello"]);
    assert.equal(found[0].name, "dahlunce");
    // Raw pick: the model entry still fires (legacy map) — but after
    // migration the model map is drained, so a raw pick fires nothing.
    found = repo.selectPromptInjections(
      { global: null, byKey: {}, byModel, byKeyModel: {}, byVariant },
      { apiKeyId: null, requestedModel: MODEL_A, resolvedModel: MODEL_A, bareModel: "DeepSeek-V4-Flash-0731" }
    );
    assert.deepEqual(found.map((f) => f.text), ["raw-model-prompt"]);
    await repo.deleteInjectModelPrompt(MODEL_A);
    const drained = await repo.getInjectModelPrompts();
    found = repo.selectPromptInjections(
      { global: null, byKey: {}, byModel: drained, byKeyModel: {}, byVariant },
      { apiKeyId: null, requestedModel: MODEL_A, resolvedModel: MODEL_A, bareModel: "DeepSeek-V4-Flash-0731" }
    );
    assert.deepEqual(found, []);
  });

  it("a disabled variant injects nothing", async () => {
    await repo.setInjectVariant("off", { model: MODEL_A, mode: "single", content: "x", enabled: false });
    const byVariant = await repo.getInjectVariants();
    const found = repo.selectPromptInjections(
      { global: null, byKey: {}, byModel: {}, byKeyModel: {}, byVariant },
      { apiKeyId: null, requestedModel: "off", resolvedModel: MODEL_A, bareModel: "DeepSeek-V4-Flash-0731" }
    );
    assert.deepEqual(found, []);
    await repo.deleteInjectVariant("off");
  });

  it("migrates stored model entries to variants and drains the model map", async () => {
    await repo.setInjectModelPrompt(MODEL_A, { mode: "single", content: "migrated-a", label: "dahl depsek" });
    await repo.setInjectModelPrompt(MODEL_B, { mode: "single", content: "migrated-b" });
    const count = await repo.migrateModelPromptsToVariants();
    assert.equal(count, 2);
    const variants = await repo.getInjectVariants();
    assert.equal(variants["dahl depsek"].model, MODEL_A);
    assert.equal(variants["dahl depsek"].content, "migrated-a");
    assert.equal(variants["dahl depsek"].comboId, null);
    assert.equal(variants["dahl-glm-5-3-flash"].model, MODEL_B);
    assert.equal(variants["dahl-glm-5-3-flash"].content, "migrated-b");
    assert.equal(await combosRepo.getComboByName("dahl-glm-5-3-flash"), null);
    assert.deepEqual(await repo.getInjectModelPrompts(), {});
    // Idempotent: a second run migrates nothing.
    assert.equal(await repo.migrateModelPromptsToVariants(), 0);
    await repo.deleteInjectVariant("dahl depsek");
    await repo.deleteInjectVariant("dahl-glm-5-3-flash");
    await repo.deleteInjectVariant("dahlunce");
  });
});
