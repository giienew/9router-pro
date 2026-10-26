import { describe, it, expect } from "vitest";
import { resolveRoutableBacking, normalizeRoutableMembers } from "../../src/lib/db/repos/nodesRepo.js";
import { resolveProviderIconId, getProviderIconSrc } from "../../src/shared/utils/providerIcon.js";

const NODES = [
  { id: "openai-compatible-chat-50648c8e-2d94-4de6-8fca-68f730de49a5", prefix: "tokenharbor", name: "tokenharbor" },
  { id: "openai-compatible-chat-aaaaaaaa-0000-4000-8000-000000000001", prefix: "gonka", name: "gonka" },
];

describe("resolveRoutableBacking (variant save AUTO)", () => {
  it("converts an alias-prefix backing to the node-id form", () => {
    expect(resolveRoutableBacking("tokenharbor/deepseek-v4-flash:free", NODES)).toBe(
      "openai-compatible-chat-50648c8e-2d94-4de6-8fca-68f730de49a5/deepseek-v4-flash:free"
    );
  });

  it("keeps a backing that is already a node id", () => {
    expect(
      resolveRoutableBacking("openai-compatible-chat-50648c8e-2d94-4de6-8fca-68f730de49a5/deepseek-v4-flash:free", NODES)
    ).toBe("openai-compatible-chat-50648c8e-2d94-4de6-8fca-68f730de49a5/deepseek-v4-flash:free");
  });

  it("keeps native provider backings untouched", () => {
    expect(resolveRoutableBacking("dahl/deepseek-ai/DeepSeek-V4-Flash-0731", NODES)).toBe(
      "dahl/deepseek-ai/DeepSeek-V4-Flash-0731"
    );
  });

  it("keeps unknown backings untouched (no false rejection)", () => {
    expect(resolveRoutableBacking("someprovider/some-model", NODES)).toBe("someprovider/some-model");
  });

  it("refuses an ambiguous prefix shared by several nodes", () => {
    const dupes = [
      { id: "node-1", prefix: "shared" },
      { id: "node-2", prefix: "shared" },
    ];
    expect(resolveRoutableBacking("shared/model-x", dupes)).toBeNull();
  });

  it("leaves bare names without a slash untouched", () => {
    expect(resolveRoutableBacking("dahlunce", NODES)).toBe("dahlunce");
  });
});

describe("normalizeRoutableMembers (combo save AUTO)", () => {
  it("converts alias members, keeps the rest, never fails the save", async () => {
    const out = await normalizeRoutableMembers(
      ["tokenharbor/deepseek-v4-flash:free", "dahl/deepseek-ai/DeepSeek-V4-Flash-0731", "shared/model-x"],
      [
        ...NODES,
        { id: "node-1", prefix: "shared" },
        { id: "node-2", prefix: "shared" },
      ]
    );
    expect(out).toEqual([
      "openai-compatible-chat-50648c8e-2d94-4de6-8fca-68f730de49a5/deepseek-v4-flash:free",
      "dahl/deepseek-ai/DeepSeek-V4-Flash-0731",
      "shared/model-x", // ambiguous -> left as-is, save still succeeds
    ]);
  });

  it("passes non-array input through untouched", async () => {
    expect(await normalizeRoutableMembers(null, NODES)).toBeNull();
    expect(await normalizeRoutableMembers(undefined, NODES)).toBeUndefined();
  });
});

describe("provider icon skip for custom node ids", () => {
  it("skips the bundled png attempt for custom node ids (no 404)", () => {
    expect(resolveProviderIconId("openai-compatible-chat-50648c8e-2d94-4de6-8fca-68f730de49a5")).toBe("");
    expect(getProviderIconSrc("openai-compatible-chat-50648c8e-2d94-4de6-8fca-68f730de49a5")).toBeNull();
    expect(resolveProviderIconId("anthropic-compatible-chat-aaaaaaaa-0000-4000-8000-000000000001")).toBe("");
  });

  it("still resolves bundled icons for built-in providers", () => {
    expect(getProviderIconSrc("dahl")).toBe("/providers/dahl.png");
    expect(getProviderIconSrc("minimax-code")).toBe("/providers/minimax.png");
  });
});
