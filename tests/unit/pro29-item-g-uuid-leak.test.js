// pro.29 item G (audit F) — no raw custom-node UUIDs in the UI:
// displayBacking falls back to "custom/<model>" when a node id has no
// prefix (deleted node / provider-nodes fetch failed), PinPickerModal titles
// through displayBacking, and the provider page shows "custom" instead of
// the raw node id. Run: npx vitest run unit/pro29-item-g-uuid-leak.test.js
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => fs.readFileSync(path.resolve(REPO_ROOT, p), "utf-8");

import { displayBacking, nodePrefixById } from "@/shared/utils/friendlyBacking";

describe("displayBacking UUID fallback", () => {
  it("shows custom/<model> for a deleted openai-compatible node", () => {
    expect(
      displayBacking("openai-compatible-chat-9f2c41a0-1111-2222-3333-abcdef012345/glm-4.7", {})
    ).toBe("custom/glm-4.7");
  });

  it("shows custom/<model> for deleted anthropic-compatible / custom-embedding nodes", () => {
    expect(
      displayBacking("anthropic-compatible-chat-9f2c41a0-1111-2222-3333-abcdef012345/claude-sonnet", {})
    ).toBe("custom/claude-sonnet");
    expect(
      displayBacking("custom-embedding-9f2c41a0-1111-2222-3333-abcdef012345/text-embedding", {})
    ).toBe("custom/text-embedding");
  });

  it("still prefers a known prefix when the node exists", () => {
    const prefixById = nodePrefixById([
      { id: "openai-compatible-chat-abc", prefix: "my-gateway" },
    ]);
    expect(
      displayBacking("openai-compatible-chat-abc/glm-4.7", prefixById)
    ).toBe("my-gateway/glm-4.7");
  });

  it("leaves non-custom backings and bare values untouched", () => {
    expect(displayBacking("openai/gpt-4", {})).toBe("openai/gpt-4");
    expect(displayBacking("gpt-4", {})).toBe("gpt-4");
    expect(displayBacking(null, {})).toBe(null);
    expect(displayBacking("", {})).toBe("");
  });
});

describe("UUID leak call sites", () => {
  it("PinPickerModal titles through displayBacking with prefixById", () => {
    const page = read("src/app/(dashboard)/dashboard/combos/page.js");
    expect(page).toContain("function PinPickerModal({ member, currentPin, onPick, onClose, prefixById = {} })");
    expect(page).toContain("title={`Pin account for ${displayBacking(member, prefixById)}`}");
    expect(page).toContain("prefixById={prefixById}");
  });

  it("provider page falls back to 'custom' instead of the raw node id", () => {
    const page = read("src/app/(dashboard)/dashboard/providers/[id]/page.js");
    expect(page).toContain('(providerNode?.prefix || "custom")');
  });
});
