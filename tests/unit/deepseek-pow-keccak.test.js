// P1-17f: the DeepSeek PoW hash moved from a vendored KECCAK-p[1600,23]
// implementation to a noble-hashes keccak port (upstream 0.5.112). These
// vectors pin the new solver to the old implementation's output: the
// challenges below are deepSeekHashV1("ds-pow-check" + nonce) from the
// pre-port code, so any drift in the permutation breaks the test.
// Run from tests/:
//   bun x vitest run unit/deepseek-pow-keccak.test.js
import { describe, it, expect } from "vitest";

const { findDeepSeekPowNonce } = await import("../../open-sse/lib/deepseek-pow-hash.js");

describe("deepseek PoW keccak port", () => {
  it("recovers nonce 0 from the old implementation's challenge", () => {
    expect(findDeepSeekPowNonce(
      "ds-pow-check",
      "f7780a3de4480d476a17645702647ae8cfeb542a7c45beb05f49236b25099e32",
      100,
    )).toBe(0);
  });

  it("recovers nonce 7 from the old implementation's challenge", () => {
    expect(findDeepSeekPowNonce(
      "ds-pow-check",
      "b2942005ac555f0149b9ef71bb7823a4c817a1b4bf4bf0a61275b5a8d7691d04",
      100,
    )).toBe(7);
  });

  it("returns -1 when no nonce in range matches", () => {
    expect(findDeepSeekPowNonce(
      "ds-pow-check",
      "0000000000000000000000000000000000000000000000000000000000000000",
      10,
    )).toBe(-1);
  });
});
