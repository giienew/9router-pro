// User override end-to-end against the real kv store (not a fake source).
//
// Writes a row through the real repo (addCustomModel), installs the real
// server reader (installUserCapsSource), and asserts getCapabilitiesForModel
// — the function chatCore calls — returns the override. This is the joint
// the fake-source unit test cannot cover: kv → loader → source → merge.
//
// Hermetic: the DB lives in a fresh temp dir created inside the test, and
// the repo modules are imported dynamically AFTER DATA_DIR is set (their
// data-dir resolution runs at import time). Nothing touches ~/.9router.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("user override end-to-end (real kv)", () => {
  it("a PATCH-written row reaches getCapabilitiesForModel on the next read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "9r-caps-test-"));
    process.env.DATA_DIR = dir;
    try {
      const { addCustomModel } = await import("@/lib/db/repos/aliasRepo.js");
      const { installUserCapsSource } = await import("@/lib/userModelCaps.js");
      const { getCapabilitiesForModel, setUserCapsSource } = await import("../../open-sse/providers/capabilities.js");

      // Detection first: reasoning-only, 128k, no vision.
      expect(getCapabilitiesForModel("nvidia", "stepfun-ai/step-5-preview").vision).toBe(false);

      await addCustomModel({
        providerAlias: "nvidia",
        id: "stepfun-ai/step-5-preview",
        type: "llm",
        capsOverride: { vision: true, contextWindow: 1000000 },
      });
      await installUserCapsSource();

      const caps = getCapabilitiesForModel("nvidia", "stepfun-ai/step-5-preview");
      expect(caps.vision).toBe(true);
      expect(caps.contextWindow).toBe(1000000);
      // Unset fields still come from the *step-* pattern.
      expect(caps.reasoning).toBe(true);
      expect(caps.thinkingFormat).toBe("step");
      expect(caps.maxOutput).toBe(64000);

      setUserCapsSource(null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
