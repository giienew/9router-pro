// R6 at-rest encryption: round-trip, legacy fallback, no-key passthrough,
// tamper rejection, nested providerSpecificData fields.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  encryptValue, decryptValue, encryptSensitiveFields, decryptSensitiveFields, countRowEncryption,
} from "../../src/lib/atRestCrypto.js";

const KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OLD = process.env.PRO_CREDENTIAL_KEY;

beforeEach(() => { process.env.PRO_CREDENTIAL_KEY = KEY_HEX; });
afterEach(() => {
  if (OLD === undefined) delete process.env.PRO_CREDENTIAL_KEY;
  else process.env.PRO_CREDENTIAL_KEY = OLD;
});

describe("at-rest crypto", () => {
  it("round-trips and never returns the plaintext envelope", () => {
    const enc = encryptValue("sk-secret-123");
    expect(enc).not.toContain("sk-secret-123");
    expect(decryptValue(enc)).toBe("sk-secret-123");
    // Same plaintext encrypts differently (random IV) but decrypts the same.
    expect(encryptValue("sk-secret-123")).not.toBe(enc);
  });

  it("passes legacy plaintext through untouched and decrypts it as-is", () => {
    expect(decryptValue("sk-plain")).toBe("sk-plain");
    expect(decryptValue(null)).toBe(null);
  });

  it("returns the envelope intact when the key is absent (never crashes reads)", () => {
    const enc = encryptValue("sk-secret-123");
    delete process.env.PRO_CREDENTIAL_KEY;
    expect(decryptValue(enc)).toBe(enc);
    expect(encryptSensitiveFields({ apiKey: "sk-x" })).toEqual({ apiKey: "sk-x" });
  });

  it("encrypts nested providerSpecificData tokens and counts rows", () => {
    const row = encryptSensitiveFields({ apiKey: "sk-a", name: "x", providerSpecificData: { refreshToken: "rt-b", username: "u" } });
    expect(row.apiKey).not.toContain("sk-a");
    expect(row.name).toBe("x");
    expect(row.providerSpecificData.username).toBe("u");
    const back = decryptSensitiveFields(row);
    expect(back.apiKey).toBe("sk-a");
    expect(back.providerSpecificData.refreshToken).toBe("rt-b");
    expect(countRowEncryption(row)).toEqual({ plaintext: 0, encrypted: 2 });
    expect(countRowEncryption({ apiKey: "sk-plain" })).toEqual({ plaintext: 1, encrypted: 0 });
  });

  it("rejects tampered ciphertext instead of returning garbage", () => {
    const enc = encryptValue("sk-secret-123");
    const parsed = JSON.parse(enc);
    parsed.data = Buffer.from("tampered").toString("base64");
    expect(decryptValue(JSON.stringify(parsed))).toBe(JSON.stringify(parsed));
  });
});
