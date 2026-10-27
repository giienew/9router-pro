import { describe, it, expect } from "vitest";
import {
  base32Encode,
  base32Decode,
  totpCode,
  verifyTotp,
  generateBackupCodes,
  hashBackupCode,
  otpauthUrl,
} from "@/lib/auth/totp.js";

// RFC 6238 SHA-1 secret (ASCII "12345678901234567890"), truncated to 6 digits.
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totp", () => {
  it("round-trips base32", () => {
    const raw = Buffer.from("12345678901234567890", "ascii");
    expect(base32Decode(base32Encode(raw)).toString("ascii")).toBe("12345678901234567890");
    expect(base32Encode(raw)).toBe(SECRET);
  });

  it("matches RFC 6238 vectors (6-digit truncation)", () => {
    expect(totpCode(SECRET, 59 * 1000)).toBe("287082");
    expect(totpCode(SECRET, 1111111109 * 1000)).toBe("081804");
    expect(totpCode(SECRET, 1111111111 * 1000)).toBe("050471");
    expect(totpCode(SECRET, 1234567890 * 1000)).toBe("005924");
    expect(totpCode(SECRET, 2000000000 * 1000)).toBe("279037");
    expect(totpCode(SECRET, 20000000000 * 1000)).toBe("353130");
  });

  it("verifies within one step of skew and rejects everything else", () => {
    const code = totpCode(SECRET, 59 * 1000);
    expect(verifyTotp(SECRET, code, 59 * 1000)).toBe(true);
    expect(verifyTotp(SECRET, code, 89 * 1000)).toBe(true); // +1 step
    expect(verifyTotp(SECRET, code, 29 * 1000)).toBe(true); // -1 step
    expect(verifyTotp(SECRET, code, 119 * 1000)).toBe(false); // +2 steps
    expect(verifyTotp(SECRET, "000000", 59 * 1000)).toBe(false);
    expect(verifyTotp(SECRET, "not-a-code", 59 * 1000)).toBe(false);
  });

  it("generates well-formed backup codes with stable hashes", () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(new Set(codes).size).toBe(10);
    expect(hashBackupCode(codes[0])).toBe(hashBackupCode(codes[0].toLowerCase().replace("-", "")));
    expect(hashBackupCode(codes[0])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("builds an otpauth URL", () => {
    const url = otpauthUrl(SECRET);
    expect(url.startsWith("otpauth://totp/")).toBe(true);
    expect(url).toContain(`secret=${SECRET}`);
  });
});
