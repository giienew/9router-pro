// 9Router Pro — combo-level prompt injection (GitHub issue #2).
// A combo's own prompt fires for EVERY member — after the API key's
// prompt, before the variant's own prompt — so one prompt steers the
// whole fallback chain instead of one variant per member. Runs against
// a throwaway DATA_DIR so the live database is never touched. Run from
// tests/:
//   bun x vitest run pro/prompt-injection-combo.test.js
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MODEL_A = "dahl/deepseek-ai/DeepSeek-V4-Flash-0731";
const MODEL_B = "dahl/zai-org/GLM-5.3-Flash";

let repo;
let combosRepo;
let statsRepo;
let driver;
let tmpDir;
let postCombos;
let putComboById;

const COMBO_ENTRY = {
  mode: "single",
  content: "combo-steer",
  turns: [],
  position: "append",
  enabled: true,
};

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-combo-"));
  process.env.DATA_DIR = tmpDir;
  repo = await import("@/lib/db/repos/promptInjectRepo.js");
  combosRepo = await import("@/lib/db/repos/combosRepo.js");
  statsRepo = await import("@/lib/db/repos/promptInjectStatsRepo.js");
  driver = await import("@/lib/db/driver.js");
  ({ POST: postCombos } = await import("../../src/app/api/combos/route.js"));
  ({ PUT: putComboById } = await import("../../src/app/api/combos/[id]/route.js"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const post = (body) =>
  postCombos(
    new Request("http://localhost/api/combos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
const put = (id, body) =>
  putComboById(
    new Request(`http://localhost/api/combos/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

describe("combo prompt in the injection stack", () => {
  const maps = {
    global: { mode: "single", content: "G", position: "append", enabled: true },
    byKey: { k1: { mode: "single", content: "K", position: "append", enabled: true } },
    byModel: { [MODEL_A]: { mode: "single", content: "M", position: "append", enabled: true } },
    byKeyModel: { k1: { [MODEL_A]: { mode: "single", content: "KM", position: "append", enabled: true } } },
    byVariant: { myvar: { model: MODEL_A, mode: "single", content: "V", position: "append", enabled: true } },
  };

  it("stacks global → key → combo → variant → model+key", () => {
    // Variant member: combo fires before the variant; the variant pick
    // suppresses the model scopes, so model+key never fires here.
    let stack = repo.selectPromptInjections(maps, {
      apiKeyId: "k1",
      requestedModel: "myvar",
      resolvedModel: MODEL_A,
      comboPrompt: COMBO_ENTRY,
      comboName: "mycombo",
    });
    assert.deepEqual(stack.map((s) => s.name), ["global", "user", "combo:mycombo", "myvar"]);
    assert.deepEqual(stack.map((s) => s.text), ["G", "K", "combo-steer", "V"]);

    // Non-variant member: combo fires, then the model and model+key scopes.
    stack = repo.selectPromptInjections(maps, {
      apiKeyId: "k1",
      requestedModel: MODEL_A,
      resolvedModel: MODEL_A,
      comboPrompt: COMBO_ENTRY,
      comboName: "mycombo",
    });
    assert.deepEqual(stack.map((s) => s.name), ["global", "user", "combo:mycombo", MODEL_A, MODEL_A]);
    assert.deepEqual(stack.map((s) => s.text), ["G", "K", "combo-steer", "M", "KM"]);
  });

  it("a non-variant member with no other prompt gets combo only", () => {
    const stack = repo.selectPromptInjections(
      { global: null, byKey: {}, byModel: {}, byKeyModel: {}, byVariant: {} },
      { apiKeyId: null, requestedModel: MODEL_A, resolvedModel: MODEL_A, comboPrompt: COMBO_ENTRY, comboName: "mycombo" },
    );
    assert.deepEqual(stack.map((s) => s.name), ["combo:mycombo"]);
    assert.deepEqual(stack.map((s) => s.text), ["combo-steer"]);
  });

  it("a disabled or NULL combo prompt leaves the stack byte-identical", () => {
    const base = { apiKeyId: "k1", requestedModel: MODEL_A, resolvedModel: MODEL_A };
    const without = repo.selectPromptInjections(maps, base);
    assert.deepEqual(
      repo.selectPromptInjections(maps, { ...base, comboPrompt: null, comboName: "mycombo" }),
      without,
    );
    assert.deepEqual(
      repo.selectPromptInjections(maps, {
        ...base,
        comboPrompt: { ...COMBO_ENTRY, enabled: false },
        comboName: "mycombo",
      }),
      without,
    );
  });

  it("a chat-mode combo prompt inserts its turns between key and variant", () => {
    const turns = [
      { role: "user", content: "the codename is BANANA-42" },
      { role: "assistant", content: "noted: BANANA-42" },
    ];
    const stack = repo.selectPromptInjections(maps, {
      apiKeyId: "k1",
      requestedModel: "myvar",
      resolvedModel: MODEL_A,
      comboPrompt: { mode: "chat", turns, position: "append", enabled: true },
      comboName: "mycombo",
    });
    assert.deepEqual(stack.map((s) => s.name), ["global", "user", "combo:mycombo", "myvar"]);
    assert.equal(stack[2].mode, "chat");
    assert.deepEqual(stack[2].turns, turns);
  });

  it("classifies the combo entry under its own scope, keeping model order", () => {
    const stack = [
      { name: "global", mode: "single" },
      { name: "combo:mycombo", mode: "single" },
      { name: MODEL_A, mode: "single" },
      { name: MODEL_A, mode: "single" },
    ];
    const fires = statsRepo.classifyInjectStack(stack, { apiKeyId: "k1", isVariantPick: false });
    assert.deepEqual(fires.map((f) => `${f.scope}:${f.key}`), [
      "global:global",
      "combo:combo:mycombo",
      `model:model:${MODEL_A}`,
      `modelKey:km:k1::${MODEL_A}`,
    ]);
  });

  it("a lone model+key entry still reads as model+key with a combo present", () => {
    const stack = [
      { name: "combo:mycombo", mode: "single" },
      { name: MODEL_A, mode: "single" },
    ];
    const fires = statsRepo.classifyInjectStack(stack, {
      apiKeyId: "k1",
      isVariantPick: false,
      keyModelNames: new Set([MODEL_A]),
    });
    assert.deepEqual(fires.map((f) => `${f.scope}:${f.key}`), [
      "combo:combo:mycombo",
      `modelKey:km:k1::${MODEL_A}`,
    ]);
  });
});

describe("cleanEntry validation (combo prompts)", () => {
  it("rejects empty content and zero-turn chat", () => {
    assert.equal(repo.cleanEntry({ mode: "single", content: "   " }), null);
    assert.equal(repo.cleanEntry({ mode: "single", content: "" }), null);
    assert.equal(repo.cleanEntry({ mode: "chat", turns: [] }), null);
    assert.equal(repo.cleanEntry({ mode: "chat", turns: [{ role: "user", content: "  " }] }), null);
    assert.equal(repo.cleanEntry(null), null);
    assert.equal(repo.cleanEntry("hello"), null);
  });

  it("keeps a valid single entry and a valid chat entry", () => {
    assert.deepEqual(repo.cleanEntry({ mode: "single", content: "hi", position: "prepend" }), {
      mode: "single",
      content: "hi",
      turns: [],
      position: "prepend",
      enabled: true,
      updatedAt: null,
      templateName: null,
      name: null,
    });
    const chat = repo.cleanEntry({
      mode: "chat",
      turns: [{ role: "user", content: "u" }, { role: "assistant", content: "a" }],
    });
    assert.equal(chat.mode, "chat");
    assert.equal(chat.content, "");
    assert.deepEqual(chat.turns, [
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
    ]);
  });
});

describe("combo prompt storage (migration + repo round-trip)", () => {
  it("migration 002 adds the prompt column and bumps the schema version", async () => {
    const db = await driver.getAdapter();
    const cols = db.all(`PRAGMA table_info(combos)`).map((c) => c.name);
    assert.ok(cols.includes("prompt"), `combos columns: ${cols.join(",")}`);
    // Migration 003 (combo context-window mode) added contextWindowMode
    // + contextWindow and bumped the schema version to 8. The loginLockouts
    // table (audit item 6, pro.29) bumped it to 9 — see
    // tests/unit/schema-v9-login-lockouts.test.js for the proof that an
    // existing v8 DB gains the table via the additive sync on next boot.
    assert.ok(cols.includes("contextWindowMode"), `combos columns: ${cols.join(",")}`);
    assert.ok(cols.includes("contextWindow"), `combos columns: ${cols.join(",")}`);
    const { SCHEMA_VERSION } = await import("@/lib/db/schema.js");
    assert.equal(SCHEMA_VERSION, 9);
  });

  it("create/update/get preserve the prompt; legacy NULL rows read null", async () => {
    const created = await combosRepo.createCombo({ name: "c-prompt", models: [MODEL_A], prompt: COMBO_ENTRY });
    assert.deepEqual(created.prompt, COMBO_ENTRY);
    assert.deepEqual((await combosRepo.getComboById(created.id)).prompt, COMBO_ENTRY);
    assert.deepEqual((await combosRepo.getComboByName("c-prompt")).prompt, COMBO_ENTRY);

    // Update swaps the prompt in place (the old UPDATE dropped it).
    const chatPrompt = {
      mode: "chat",
      content: "",
      turns: [{ role: "user", content: "u1" }],
      position: "prepend",
      enabled: true,
    };
    const updated = await combosRepo.updateCombo(created.id, { prompt: chatPrompt });
    assert.deepEqual(updated.prompt, chatPrompt);
    assert.deepEqual((await combosRepo.getComboById(created.id)).prompt, chatPrompt);

    // An update without a prompt key leaves the stored prompt untouched.
    await combosRepo.updateCombo(created.id, { models: [MODEL_A, MODEL_B] });
    assert.deepEqual((await combosRepo.getComboById(created.id)).prompt, chatPrompt);

    // prompt: null clears it.
    await combosRepo.updateCombo(created.id, { prompt: null });
    assert.equal((await combosRepo.getComboById(created.id)).prompt, null);

    // A combo created without a prompt reads null (legacy rows).
    const plain = await combosRepo.createCombo({ name: "c-plain", models: [MODEL_A] });
    assert.equal(plain.prompt, null);
    assert.equal((await combosRepo.getComboById(plain.id)).prompt, null);

    await combosRepo.deleteCombo(created.id);
    await combosRepo.deleteCombo(plain.id);
  });
});

describe("POST/PUT /api/combos prompt handling", () => {
  it("POST accepts a valid prompt and stores it", async () => {
    const res = await post({ name: "api-c1", models: [MODEL_A], prompt: COMBO_ENTRY });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.deepEqual(body.prompt, { ...COMBO_ENTRY, updatedAt: null, templateName: null, name: null });
    assert.deepEqual((await combosRepo.getComboById(body.id)).prompt, body.prompt);
    await combosRepo.deleteCombo(body.id);
  });

  it("POST rejects an invalid prompt (empty content / zero-turn chat)", async () => {
    for (const bad of [
      { mode: "single", content: "   " },
      { mode: "chat", turns: [] },
      { mode: "single" },
    ]) {
      const res = await post({ name: "api-bad", models: [MODEL_A], prompt: bad });
      assert.equal(res.status, 400);
      assert.match(await res.text(), /Combo prompt needs/);
    }
    assert.equal(await combosRepo.getComboByName("api-bad"), null);
  });

  it("PUT accepts a valid prompt, rejects invalid ones, and clears on prompt:null", async () => {
    const created = await combosRepo.createCombo({ name: "api-c2", models: [MODEL_A] });
    // Accept: persisted, not silently dropped.
    let res = await put(created.id, { prompt: COMBO_ENTRY });
    assert.equal(res.status, 200);
    const putBody = await res.json();
    assert.deepEqual(putBody.prompt, { ...COMBO_ENTRY, updatedAt: null, templateName: null, name: null });
    assert.deepEqual((await combosRepo.getComboById(created.id)).prompt, putBody.prompt);

    // Reject: empty content and zero-turn chat both 400, stored prompt kept.
    for (const bad of [{ mode: "single", content: "" }, { mode: "chat", turns: [] }]) {
      res = await put(created.id, { prompt: bad });
      assert.equal(res.status, 400);
      assert.match(await res.text(), /Combo prompt needs/);
    }
    assert.notEqual((await combosRepo.getComboById(created.id)).prompt, null);

    // A PUT without a prompt key leaves the stored prompt untouched.
    res = await put(created.id, { models: [MODEL_A, MODEL_B] });
    assert.equal(res.status, 200);
    assert.notEqual((await combosRepo.getComboById(created.id)).prompt, null);

    // prompt: null clears it.
    res = await put(created.id, { prompt: null });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).prompt, null);
    assert.equal((await combosRepo.getComboById(created.id)).prompt, null);

    await combosRepo.deleteCombo(created.id);
  });
});
