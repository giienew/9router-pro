import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLIENT_PATH = path.resolve(
  REPO_ROOT,
  "src/app/(dashboard)/dashboard/prompt-injection/PromptInjectionClient.js"
);

function read() {
  return fs.readFileSync(CLIENT_PATH, "utf-8");
}

describe("Prompt Injection edit form — template source", () => {
  it("the edit form offers templates (no allowTemplateSource={false} left)", () => {
    const source = read();
    expect(source).not.toContain("allowTemplateSource={false}");
    // Both call sites (edit + add) pass the flag.
    const matches = source.match(/allowTemplateSource/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(3); // prop + 2 call sites
  });

  it("applying a template in edit mode keeps the entry's enabled state", () => {
    const source = read();
    // templateEnabled derives from the entry being edited in edit mode,
    // and is true for a new entry in create mode.
    expect(source).toContain(
      "const templateEnabled = lockSource ? sourceEntry?.enabled !== false : true;"
    );
    expect(source).toContain("{ ...template, enabled: templateEnabled }");
    expect(source).toContain("enabled: templateEnabled }");
  });

  it("no hardcoded enabled: true remains on the template-apply paths", () => {
    const source = read();
    // The only template-apply paths are editorInitial and the preview Save.
    expect(source).not.toContain("{ ...template, enabled: true }");
    expect(source).not.toContain("position: template.position, enabled: true }");
  });

  it("the template picker and preview still render when allowed", () => {
    const source = read();
    expect(source).toContain("{allowTemplateSource && templates.length > 0 && (");
    expect(source).toContain("From template");
  });
});
