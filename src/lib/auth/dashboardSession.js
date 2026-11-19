import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "@/lib/dataDir";
import { getSettings, updateSettings } from "@/lib/localDb";
import { shouldSetSecureCookie } from "./secureCookie.js";

const SESSION_MAX_AGE_SEC = 24 * 60 * 60;

// A stored dashboard password is ALWAYS a bcrypt hash. Anything else in
// settings.password is a legacy plaintext value awaiting migration (see
// ensurePasswordReady) — it must never verify as-is.
const BCRYPT_HASH_RE = /^\$2[ab]\$\d{2}\$[./A-Za-z0-9]{53}$/;

export function isBcryptHash(value) {
  return typeof value === "string" && BCRYPT_HASH_RE.test(value);
}

export async function hashDashboardPassword(password) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

// bcrypt-only verification. Returns false for a missing, non-string, or
// non-bcrypt stored value: a legacy plaintext stored value can never
// authenticate until ensurePasswordReady() has re-hashed it (fail closed).
// There is no plaintext comparison anywhere in this path.
export async function verifyStoredPassword(password, storedHash) {
  if (typeof password !== "string" || !password) return false;
  if (!isBcryptHash(storedHash)) return false;
  try {
    return await bcrypt.compare(password, storedHash);
  } catch {
    return false;
  }
}

// Monotonic session epoch, persisted in settings. Bumped on every password
// change; tokens carry the epoch they were issued at and verify only when
// it still matches. Tokens issued before this change have no `tv` claim
// and are treated as epoch 0, so a deploy alone never logs anyone out.
export function getTokenVersion(settings) {
  return Number.isInteger(settings?.tokenVersion) && settings.tokenVersion >= 0
    ? settings.tokenVersion
    : 0;
}

// Fingerprint of the CURRENT stored password hash (sha256 of the hash, never
// of the password itself). Tokens carry it so that ANY password change —
// including paths that do not bump tokenVersion, e.g. the CLI reset that
// clears settings.password — invalidates tokens issued before the change.
// Legacy tokens without a `ph` claim fall back to the tokenVersion check.
function passwordFingerprint(settings) {
  return crypto
    .createHash("sha256")
    .update(String(settings?.password ?? ""))
    .digest("hex");
}

// First-boot / legacy migration. Called before any password verification:
// - stored bcrypt hash: no-op, login proceeds on the hash path.
// - stored legacy plaintext: re-hash the STORED VALUE itself and persist
//   it, so the same password keeps working via bcrypt afterwards. No
//   plaintext comparison happens anywhere in this path.
// - no stored password + INITIAL_PASSWORD set: hash the env value into
//   settings.password (first boot), so the env secret is never compared
//   in plaintext and never left unhashed.
// - no stored password + no env value: nothing to migrate; there is no
//   usable password and verification fails closed (no public default).
export async function ensurePasswordReady() {
  const settings = await getSettings();
  const stored = settings?.password;
  if (stored && isBcryptHash(stored)) return settings;
  if (typeof stored === "string" && stored.length > 0) {
    const hashed = await hashDashboardPassword(stored);
    return updateSettings({ password: hashed });
  }
  const initial = process.env.INITIAL_PASSWORD;
  if (typeof initial === "string" && initial.length > 0) {
    const hashed = await hashDashboardPassword(initial);
    return updateSettings({ password: hashed });
  }
  return settings;
}

function loadJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(DATA_DIR, "jwt-secret");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {}
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const generated = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

const SECRET = new TextEncoder().encode(loadJwtSecret());

// Secure is the DEFAULT, not opt-in (audit item 6e, pro.29): the session
// cookie is flagged Secure unless the operator explicitly opts out with
// AUTH_COOKIE_SECURE=false (plain-HTTP LAN deployments that cannot do TLS).
export function shouldUseSecureCookie(request) {
  return shouldSetSecureCookie();
}

export async function createDashboardAuthToken(claims = {}) {
  const settings = await getSettings().catch(() => null);
  return new SignJWT({
    authenticated: true,
    ...claims,
    tv: getTokenVersion(settings),
    ph: passwordFingerprint(settings),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(SECRET);
}

// Shared revocation check for verify + session read: the token's epoch must
// still be current, and — when the token carries a password fingerprint —
// the fingerprint must still match the stored password hash. Any failure
// (bad signature, expired, revoked, settings unreadable) fails closed.
async function isTokenPayloadCurrent(payload) {
  const settings = await getSettings();
  if (getTokenVersion(settings) !== (Number.isInteger(payload?.tv) && payload.tv >= 0 ? payload.tv : 0)) {
    return false;
  }
  if (typeof payload?.ph === "string" && payload.ph !== passwordFingerprint(settings)) {
    return false;
  }
  return true;
}

export async function verifyDashboardAuthToken(token) {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, SECRET);
    return await isTokenPayloadCurrent(payload);
  } catch {
    return false;
  }
}

export async function getDashboardAuthSession(token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, SECRET);
    if (!(await isTokenPayloadCurrent(payload))) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function setDashboardAuthCookie(cookieStore, request, claims = {}) {
  const token = await createDashboardAuthToken(claims);
  cookieStore.set("auth_token", token, {
    httpOnly: true,
    secure: shouldUseSecureCookie(request),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SEC,
  });
}

export function clearDashboardAuthCookie(cookieStore) {
  cookieStore.delete("auth_token");
}

// Verify the current dashboard password (re-auth for sensitive actions).
// bcrypt-only, after first-boot/legacy migration — see ensurePasswordReady.
export async function verifyDashboardPassword(password) {
  if (typeof password !== "string" || !password) return false;
  const settings = await ensurePasswordReady();
  return verifyStoredPassword(password, settings?.password);
}
