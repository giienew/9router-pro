import { describe, expect, it } from "vitest";
import { normalizePromptMap, normalizeKeyModelMap, buildProviderResolver } from "../../src/lib/db/normalizeInjections.js";

const entry = (tag) => ({ mode: "single", content: tag, enabled: true, position: "prepend" });

const combos = [
  { name: "dpsk_un", models: ["gonka/deepseek-ai/DeepSeek-V4-Flash-0731", "dahl/deepseek-ai/DeepSeek-V4-Flash-0731", "dpsk4_1_un"] },
  { name: "dpsk4_1_un", models: ["opencode/deepseek-v4.1-flash-free", "dahl/deepseek-ai/DeepSeek-V4-Flash-0731"] },
  { name: "glm_un", models: ["oc/glm-5.3-flash-free", "gonka/zai-org/GLM-5.3-Flash", "dahl/zai-org/GLM-5.3-Flash"] },
  { name: "loop_a", models: ["loop_b"] },
  { name: "loop_b", models: ["loop_a"] },
  { name: "empty_un", models: ["some-alias-without-slash"] },
];

// Node prefix "gonka" resolves to its node id, like the request path does.
const resolve = (p) => (p === "gonka" ? "node-gonka" : p);

describe("normalizePromptMap", () => {
  it("expands a combo-name entry to its leaves' resolved provider/models, nested included, deduped", async () => {
    const out = await normalizePromptMap({ dpsk_un: entry("deepseek") }, combos, resolve);
    expect(out).toEqual({
      "node-gonka/deepseek-ai/DeepSeek-V4-Flash-0731": entry("deepseek"),
      "dahl/deepseek-ai/DeepSeek-V4-Flash-0731": entry("deepseek"),
      "opencode/deepseek-v4.1-flash-free": entry("deepseek"),
    });
  });

  it("never overwrites an existing provider/model entry", async () => {
    const out = await normalizePromptMap(
      { dpsk_un: entry("old"), "dahl/deepseek-ai/DeepSeek-V4-Flash-0731": entry("explicit") },
      combos,
      resolve
    );
    expect(out["dahl/deepseek-ai/DeepSeek-V4-Flash-0731"]).toEqual(entry("explicit"));
    expect(out["node-gonka/deepseek-ai/DeepSeek-V4-Flash-0731"]).toEqual(entry("old"));
    expect(out["opencode/deepseek-v4.1-flash-free"]).toEqual(entry("old"));
    expect(out).not.toHaveProperty("dpsk_un");
  });

  it("expands bare-id keys to every provider/model serving that bare id", async () => {
    const out = await normalizePromptMap({ "zai-org/GLM-5.3-Flash": entry("glm") }, combos, resolve);
    expect(out).toEqual({
      "node-gonka/zai-org/GLM-5.3-Flash": entry("glm"),
      "dahl/zai-org/GLM-5.3-Flash": entry("glm"),
    });
  });

  it("leaves unknown keys untouched and keeps unresolvable combo keys", async () => {
    const out = await normalizePromptMap(
      { "nope/model-x": entry("kept"), loop_a: entry("loop"), empty_un: entry("empty"), ghost_un: entry("ghost") },
      combos,
      resolve
    );
    expect(out["nope/model-x"]).toEqual(entry("kept"));
    expect(out).toHaveProperty("loop_a");
    expect(out).toHaveProperty("empty_un");
    expect(out).toHaveProperty("ghost_un");
  });

  it("does not mutate its inputs", async () => {
    const input = { dpsk_un: entry("deepseek") };
    const snapshot = JSON.parse(JSON.stringify(input));
    await normalizePromptMap(input, combos, resolve);
    expect(input).toEqual(snapshot);
  });

  it("passes non-objects through", async () => {
    expect(await normalizePromptMap(null, combos, resolve)).toBeNull();
    expect(await normalizePromptMap([], combos, resolve)).toEqual([]);
  });
});

describe("normalizeKeyModelMap", () => {
  it("expands inside each per-key map", async () => {
    const out = await normalizeKeyModelMap(
      { "key-1": { glm_un: entry("glm") }, "key-2": { "zai-org/GLM-5.3-Flash": entry("kept") } },
      combos,
      resolve
    );
    expect(out["key-1"]).toEqual({
      "oc/glm-5.3-flash-free": entry("glm"),
      "node-gonka/zai-org/GLM-5.3-Flash": entry("glm"),
      "dahl/zai-org/GLM-5.3-Flash": entry("glm"),
    });
    expect(out["key-2"]).toEqual({
      "node-gonka/zai-org/GLM-5.3-Flash": entry("kept"),
      "dahl/zai-org/GLM-5.3-Flash": entry("kept"),
    });
  });
});

describe("buildProviderResolver", () => {
  it("prefers node prefixes, then the registry alias, then identity", () => {
    const resolveProvider = buildProviderResolver(
      [{ id: "node-gonka", prefix: "gonka" }],
      (p) => (p === "oc" ? "opencode" : p)
    );
    expect(resolveProvider("gonka")).toBe("node-gonka");
    expect(resolveProvider("oc")).toBe("opencode");
    expect(resolveProvider("dahl")).toBe("dahl");
  });
});
