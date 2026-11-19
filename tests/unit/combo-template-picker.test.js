// Combo edit form offers Prompt Injection templates for the combo prompt.
// Source-assertion tests (repo pattern): the combos page ComboFormModal
// fetches /api/prompt-injection templates, filters to single-mode, and a
// template pick fills the prompt text + position.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const src = readFileSync(
  join(root, "src/app/(dashboard)/dashboard/combos/page.js"),
  "utf8"
);

describe("combo form template picker", () => {
  it("fetches prompt-injection templates when the modal opens", () => {
    expect(src).toContain('fetch("/api/prompt-injection")');
    expect(src).toContain("inj.templates");
  });

  it("keeps only single-mode templates with content (combo prompt is single-mode)", () => {
    expect(src).toContain('t.mode !== "chat"');
    expect(src).toContain('(t.content || "").trim()');
  });

  it("renders a template dropdown above the combo prompt textarea", () => {
    expect(src).toContain("Use a template…");
    expect(src).toContain("templates.length > 0");
  });

  it("picking a template fills the prompt text and its position", () => {
    expect(src).toContain("handleTemplatePick");
    expect(src).toContain("setPromptText(template.content");
    expect(src).toContain('template.position === "prepend"');
    expect(src).toContain("setPromptPosition(template.position)");
  });
});
