import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// pro.29 (audit item 3): router keys are hashed at rest and disclosed only
// once (POST 201 / PUT regenerate). The list shows only the mask, so a
// created key can NEVER be viewed or copied later — the modal must say it
// is one-time only. The earlier "view or copy it later" guidance was true
// when keys were stored in plaintext; it became a lie the moment hashing
// landed, so it is reverted here (with its translations restored from
// before commit a3ca2f9b).
const oneTimeGuidance = "This is the only time you will see this key. Store it securely.";
const falseGuidance = "Store this key securely. You can view or copy it later from the API Keys list.";
const source = readFileSync(
  new URL("../../src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js", import.meta.url),
  "utf-8"
);

describe("API key visibility guidance source verification", () => {
  it("explains that a created key is shown only once", () => {
    // The modal title is a dynamic JSX expression (created / regenerated /
    // updated), so anchor on the Created Key Modal block instead of a
    // literal title attribute.
    const modal = source.match(/\{.*Created Key Modal.*\}[\s\S]*?<\/Modal>/)?.[0];
    expect(modal).toBeDefined();
    expect(modal).toContain(oneTimeGuidance);
    expect(modal).not.toContain(falseGuidance);
  });

  it("retains the list's reveal and copy controls", () => {
    expect(source).toContain("visibleKeys.has(key.id) ? key.key : maskKey(key.key)");
    expect(source).toContain("onClick={() => toggleKeyVisibility(key.id)}");
    expect(source).toContain("onClick={() => copy(key.key, key.id)}");
  });

  it.each(["fa", "id", "km", "pt-BR", "th", "zh-CN"])(
    "updates the existing %s translation without retaining the false view-later claim",
    (locale) => {
      const translations = JSON.parse(readFileSync(
        new URL(`../../public/i18n/literals/${locale}.json`, import.meta.url),
        "utf-8"
      ));
      expect(translations).not.toHaveProperty(falseGuidance);
      expect(translations[oneTimeGuidance]).toEqual(expect.any(String));
      expect(translations[oneTimeGuidance].trim()).not.toBe("");
      expect(translations[oneTimeGuidance]).not.toBe(oneTimeGuidance);
    }
  );
});
