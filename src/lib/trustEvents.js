// Trust inbox + security log (R2/R3, 9Router Pro, original code).
// Events live in the trustEvents / securityLog tables added to TABLES in
// src/lib/db/schema.js; the additive auto-sync in migrate.js creates them
// on boot, so no existing table is altered and no migration rewrites data.
// Quota-pressure semantics: warn at >=90% of the enforced cap, critical
// at the cap. An unread event suppresses duplicates of the same
// kind+subject+level; clearing the condition (clearTrustSubject) re-arms
// it, so a recurrence shows up as unread again instead of being swallowed.
import { randomUUID } from "node:crypto";

export const QUOTA_WARN_RATIO = 0.9;

export function quotaPressureLevel(used, cap) {
  const u = Number(used);
  const c = Number(cap);
  if (!Number.isFinite(u) || !Number.isFinite(c) || c <= 0) return null;
  if (u >= c) return "critical";
  if (u / c >= QUOTA_WARN_RATIO) return "warn";
  return null;
}

export function clientIpFromRequest(request) {
  try {
    const fwd = request?.headers?.get?.("x-forwarded-for");
    if (fwd) return fwd.split(",")[0].trim();
    const real = request?.headers?.get?.("x-real-ip");
    if (real) return real.trim();
  } catch {}
  return null;
}

function ensureTables(db) {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS trustEvents (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, level TEXT NOT NULL, subject TEXT, title TEXT NOT NULL, detail TEXT, createdAt TEXT NOT NULL, read INTEGER DEFAULT 0)`);
    db.exec(`CREATE TABLE IF NOT EXISTS securityLog (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, ip TEXT, userAgent TEXT, detail TEXT, breach INTEGER DEFAULT 0, createdAt TEXT NOT NULL)`);
  } catch {}
}

export function recordTrustEvent(db, { kind, level = "info", subject = null, title, detail = null } = {}) {
  if (!db || !kind || !title) return null;
  try {
    ensureTables(db);
    const existing = db.get(
      `SELECT id FROM trustEvents WHERE kind = ? AND COALESCE(subject, '') = ? AND level = ? AND read = 0 ORDER BY id DESC LIMIT 1`,
      [kind, subject || "", level],
    );
    if (existing) return existing.id;
    const now = new Date().toISOString();
    const info = db.run(
      `INSERT INTO trustEvents(kind, level, subject, title, detail, createdAt, read) VALUES(?, ?, ?, ?, ?, ?, 0)`,
      [kind, level, subject, title, detail, now],
    );
    return info?.lastInsertRowid ?? null;
  } catch { return null; }
}

export function clearTrustSubject(db, kind, subject) {
  if (!db) return 0;
  try {
    ensureTables(db);
    const info = db.run(`UPDATE trustEvents SET read = 1 WHERE kind = ? AND COALESCE(subject, '') = ? AND read = 0`, [kind, subject || ""]);
    return info?.changes ?? 0;
  } catch { return 0; }
}

// Quota-pressure entry point: records warn/critical, or clears (re-arms)
// when usage drops back below the warn threshold.
export function recordQuotaPressure(db, subject, used, cap, budgetKind = "tokens") {
  const level = quotaPressureLevel(used, cap);
  if (!level) return clearTrustSubject(db, "quota", subject);
  const title = level === "critical"
    ? `${subject} hit its ${budgetKind} cap (${used}/${cap})`
    : `${subject} at ${Math.round((used / cap) * 100)}% of its ${budgetKind} cap (${used}/${cap})`;
  return recordTrustEvent(db, { kind: "quota", level, subject, title, detail: `Budget kind: ${budgetKind}.` });
}

export function listTrustEvents(db, { unreadOnly = false, limit = 100 } = {}) {
  if (!db) return [];
  try {
    ensureTables(db);
    const rows = db.all(
      `SELECT * FROM trustEvents ${unreadOnly ? "WHERE read = 0" : ""} ORDER BY createdAt DESC, id DESC LIMIT ?`,
      [Math.min(500, Math.max(1, limit || 100))],
    );
    return (rows || []).map((r) => ({ ...r, read: r.read === 1 || r.read === true }));
  } catch { return []; }
}

export function trustUnreadCount(db) {
  if (!db) return 0;
  try {
    ensureTables(db);
    return db.get(`SELECT COUNT(*) as c FROM trustEvents WHERE read = 0`)?.c ?? 0;
  } catch { return 0; }
}

export function markTrustEventRead(db, id) {
  if (!db) return false;
  try {
    ensureTables(db);
    const info = db.run(`UPDATE trustEvents SET read = 1 WHERE id = ?`, [id]);
    return (info?.changes ?? 0) > 0;
  } catch { return false; }
}

export function markAllTrustEventsRead(db) {
  if (!db) return 0;
  try {
    ensureTables(db);
    return db.run(`UPDATE trustEvents SET read = 1 WHERE read = 0`)?.changes ?? 0;
  } catch { return 0; }
}

// Security log: append-only. A login-failed event is flagged as a breach
// signal when 5+ failures from the same IP arrived in the last hour.
export function recordSecurityEvent(db, { event, ip = null, userAgent = null, detail = null } = {}) {
  if (!db || !event) return null;
  try {
    ensureTables(db);
    let breach = 0;
    if (event === "login-failed" && ip) {
      const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
      const row = db.get(`SELECT COUNT(*) as c FROM securityLog WHERE event = 'login-failed' AND ip = ? AND createdAt >= ?`, [ip, hourAgo]);
      if ((row?.c ?? 0) >= 4) breach = 1;
    }
    const now = new Date().toISOString();
    const info = db.run(
      `INSERT INTO securityLog(event, ip, userAgent, detail, breach, createdAt) VALUES(?, ?, ?, ?, ?, ?)`,
      [event, ip, userAgent, detail, breach, now],
    );
    if (breach) {
      recordTrustEvent(db, { kind: "security", level: "critical", subject: ip, title: `Repeated failed sign-ins from ${ip}`, detail: "5+ failed sign-ins in the last hour — check whether this IP is yours." });
    }
    return info?.lastInsertRowid ?? null;
  } catch { return null; }
}

export function listSecurityEvents(db, { limit = 100 } = {}) {
  if (!db) return [];
  try {
    ensureTables(db);
    const rows = db.all(`SELECT * FROM securityLog ORDER BY createdAt DESC, id DESC LIMIT ?`, [Math.min(500, Math.max(1, limit || 100))]);
    return (rows || []).map((r) => ({ ...r, breach: r.breach === 1 || r.breach === true }));
  } catch { return []; }
}

export function newEventId() { return randomUUID(); }
