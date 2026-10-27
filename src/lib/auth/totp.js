// TOTP two-factor auth for dashboard password login (RFC 6238, SHA-1).
// No new dependency: HMAC + base32 are implemented here. Secrets live in
// the kv store (scope "totp"), never in the generic settings object, so a
// PATCH /api/settings can neither read nor overwrite them. Backup codes
// are stored as SHA-256 hashes and consumed on use.
import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { makeKv } from "@/lib/db/helpers/kvStore.js";

const kv = makeKv("totp");
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf) {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  while (out.length % 8 !== 0) out += "=";
  return out;
}

export function base32Decode(str) {
  const clean = String(str || "").replace(/[\s=]/g, "").toUpperCase();
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret() {
  return base32Encode(randomBytes(20));
}

export function totpCode(secret, timeMs = Date.now(), stepSeconds = 30, digits = 6) {
  const key = base32Decode(secret);
  const counter = Math.floor(timeMs / 1000 / stepSeconds);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(code % 10 ** digits).padStart(digits, "0");
}

// Accepts the current step plus one step each side (clock skew). The code
// must be exactly 6 digits; anything else fails closed.
export function verifyTotp(secret, code, timeMs = Date.now()) {
  const clean = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  for (const delta of [-1, 0, 1]) {
    try {
      // A negative shifted time (near epoch) throws in the counter math;
      // skip that step instead of aborting the whole check.
      if (timeMs + delta * 30 * 1000 < 0) continue;
      const expected = totpCode(secret, timeMs + delta * 30 * 1000);
      if (clean.length === expected.length && timingSafeEqual(Buffer.from(clean), Buffer.from(expected))) return true;
    } catch {
      continue;
    }
  }
  return false;
}

const BACKUP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateBackupCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    let code = "";
    const bytes = randomBytes(8);
    for (const b of bytes) code += BACKUP_ALPHABET[b % BACKUP_ALPHABET.length];
    codes.push(`${code.slice(0, 4)}-${code.slice(4)}`);
  }
  return codes;
}

export function hashBackupCode(code) {
  return createHash("sha256").update(String(code).replace(/[\s-]/g, "").toUpperCase()).digest("hex");
}

export function otpauthUrl(secret, account = "9Router Pro") {
  const issuer = "9Router Pro";
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export async function getTotpConfig() {
  try {
    return (await kv.get("config", null)) || { enabled: false, secret: "", backupHashes: [], pendingSecret: "", pendingBackupHashes: [] };
  } catch {
    return { enabled: false, secret: "", backupHashes: [], pendingSecret: "", pendingBackupHashes: [] };
  }
}

export async function isTotpEnabled() {
  const cfg = await getTotpConfig();
  return cfg.enabled === true && Boolean(cfg.secret);
}

// Step 1 of setup: stores a PENDING secret + backup hashes. Nothing is
// enforced until step 2 (enable) proves a valid code.
export async function startTotpSetup() {
  const secret = generateTotpSecret();
  const backupCodes = generateBackupCodes();
  const cfg = await getTotpConfig();
  await kv.set("config", {
    ...cfg,
    pendingSecret: secret,
    pendingBackupHashes: backupCodes.map(hashBackupCode),
  });
  return { secret, otpauthUrl: otpauthUrl(secret), backupCodes };
}

// Step 2: only a valid code against the pending secret activates TOTP.
export async function enableTotp(code) {
  const cfg = await getTotpConfig();
  if (!cfg.pendingSecret) return false;
  if (!verifyTotp(cfg.pendingSecret, code)) return false;
  await kv.set("config", {
    enabled: true,
    secret: cfg.pendingSecret,
    backupHashes: cfg.pendingBackupHashes || [],
    pendingSecret: "",
    pendingBackupHashes: [],
    createdAt: new Date().toISOString(),
  });
  return true;
}

export async function disableTotp(codeOrBackup) {
  const cfg = await getTotpConfig();
  if (!cfg.enabled) return false;
  if (verifyTotp(cfg.secret, codeOrBackup)) {
    await kv.set("config", { enabled: false, secret: "", backupHashes: [], pendingSecret: "", pendingBackupHashes: [] });
    return true;
  }
  const hash = hashBackupCode(codeOrBackup);
  if ((cfg.backupHashes || []).includes(hash)) {
    await kv.set("config", { enabled: false, secret: "", backupHashes: [], pendingSecret: "", pendingBackupHashes: [] });
    return true;
  }
  return false;
}

// Returns true and consumes the code when a backup code matches.
export async function consumeBackupCode(code) {
  const cfg = await getTotpConfig();
  if (!cfg.enabled) return false;
  const hash = hashBackupCode(code);
  const rest = (cfg.backupHashes || []).filter((h) => h !== hash);
  if (rest.length === (cfg.backupHashes || []).length) return false;
  await kv.set("config", { ...cfg, backupHashes: rest });
  return true;
}
