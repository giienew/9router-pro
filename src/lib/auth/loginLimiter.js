// Progressive lockout for dashboard login, persisted in the DB
// (audit item 6f). A process restart used to clear every lockout because
// state lived in a module-level Map; it now lives in the loginLockouts
// table, so a restart does not clear it. The exported API stays
// synchronous (the login route calls it without await): reads/writes go
// through the sync adapter once it is initialized, with the in-memory map
// kept as a write-through cache and as the fallback before DB init — a
// transient DB error never loses a lockout, and a pre-init memory entry is
// seeded into the DB on first sight.
import { hasTrustedPeerHeaders } from "./trustedPeer.js";
import { getAdapter, getAdapterSync } from "@/lib/db/driver.js";

const MAX_FAILS_BEFORE_LOCK = 5;
const LOCK_STEPS_MS = [30_000, 120_000, 600_000, 1_800_000]; // 30s, 2m, 10m, 30m
const FAIL_WINDOW_MS = 60 * 60 * 1000; // 1h since last fail → auto reset

const attempts = new Map(); // ip → { fails, lockUntil, lockLevel, lastFailAt }

function now() { return Date.now(); }

function getDb() {
  try {
    const db = getAdapterSync();
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS loginLockouts (ip TEXT PRIMARY KEY, fails INTEGER DEFAULT 0, lockUntil INTEGER DEFAULT 0, lockLevel INTEGER DEFAULT 0, lastFailAt INTEGER DEFAULT 0)`);
    } catch {}
    return db;
  } catch {
    // DB not initialized yet (first request before any getAdapter() call):
    // warm it up in the background so later calls in this process persist.
    getAdapter().catch(() => {});
    return null;
  }
}

function loadEntry(ip) {
  const db = getDb();
  let entry = null;
  let fromDb = false;
  if (db) {
    try {
      const row = db.get(`SELECT fails, lockUntil, lockLevel, lastFailAt FROM loginLockouts WHERE ip = ?`, [ip]);
      if (row) {
        // NOTE: no `| 0` here — lockUntil/lastFailAt are ms epoch values
        // (~1.8e12) that a 32-bit coercion would truncate to garbage.
        entry = { fails: Number(row.fails) || 0, lockUntil: Number(row.lockUntil) || 0, lockLevel: Number(row.lockLevel) || 0, lastFailAt: Number(row.lastFailAt) || 0 };
        fromDb = true;
      }
    } catch {}
  }
  if (!entry) entry = attempts.get(ip) || null;
  if (entry && db && !fromDb) {
    // Seed a pre-init memory entry into the DB so it survives a restart.
    try {
      db.run(`INSERT OR REPLACE INTO loginLockouts(ip, fails, lockUntil, lockLevel, lastFailAt) VALUES(?, ?, ?, ?, ?)`,
        [ip, entry.fails, entry.lockUntil, entry.lockLevel, entry.lastFailAt]);
    } catch {}
  }
  return entry;
}

function saveEntry(ip, entry) {
  attempts.set(ip, { ...entry });
  const db = getDb();
  if (!db) return;
  try {
    db.run(`INSERT OR REPLACE INTO loginLockouts(ip, fails, lockUntil, lockLevel, lastFailAt) VALUES(?, ?, ?, ?, ?)`,
      [ip, entry.fails, entry.lockUntil, entry.lockLevel, entry.lastFailAt]);
  } catch {}
}

function deleteEntry(ip) {
  attempts.delete(ip);
  const db = getDb();
  if (!db) return;
  try { db.run(`DELETE FROM loginLockouts WHERE ip = ?`, [ip]); } catch {}
}

function getEntry(ip) {
  const e = loadEntry(ip);
  if (!e) return null;
  // Auto reset if window expired and not currently locked
  if (e.lastFailAt && now() - e.lastFailAt > FAIL_WINDOW_MS && (!e.lockUntil || now() >= e.lockUntil)) {
    deleteEntry(ip);
    return null;
  }
  return e;
}

export function checkLock(ip) {
  const e = getEntry(ip);
  if (!e || !e.lockUntil) return { locked: false };
  const remaining = e.lockUntil - now();
  if (remaining <= 0) return { locked: false };
  return { locked: true, retryAfter: Math.ceil(remaining / 1000) };
}

export function recordFail(ip) {
  const e = getEntry(ip) || { fails: 0, lockUntil: 0, lockLevel: 0, lastFailAt: 0 };
  e.fails += 1;
  e.lastFailAt = now();
  if (e.fails >= MAX_FAILS_BEFORE_LOCK) {
    const step = LOCK_STEPS_MS[Math.min(e.lockLevel, LOCK_STEPS_MS.length - 1)];
    e.lockUntil = now() + step;
    e.lockLevel += 1;
    e.fails = 0;
  }
  saveEntry(ip, e);
  return { remainingBeforeLock: Math.max(0, MAX_FAILS_BEFORE_LOCK - e.fails) };
}

export function recordSuccess(ip) {
  deleteEntry(ip);
}

export function getClientIp(request) {
  // Trusted only when custom-server.js proves it stamped the header from the TCP socket;
  // otherwise a client could rotate the value to escape its own lockout bucket.
  if (hasTrustedPeerHeaders(request)) {
    const realIp = request.headers.get("x-9r-real-ip");
    if (realIp) return realIp;
  }
  // CF-Connecting-IP is trustworthy only when custom-server.js vouched for
  // it (audit item 6g): the wrapper keeps the header only when the TCP peer
  // is a Cloudflare edge address or the local tunnel peer, and stamps the
  // peer token to prove it ran. Without that proof the header is just
  // attacker-supplied input — a client could rotate it to escape its own
  // lockout bucket — so it is ignored and the request falls through to the
  // single "unknown" bucket below.
  if (hasTrustedPeerHeaders(request)) {
    const cfIp = request.headers.get("cf-connecting-ip");
    if (cfIp) return cfIp.trim();
  }
  // Behind a trusted reverse proxy that overwrites XFF with the real client IP.
  if (process.env.TRUST_PROXY === "true") {
    const xff = request.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
  }
  // Direct exposure without custom-server: single bucket so spoofed XFF
  // rotation cannot escape the limiter.
  return "unknown";
}
