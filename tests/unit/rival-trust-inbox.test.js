// R2/R3 trust inbox + security log: pure thresholds, dedupe/re-arm, breach flag.
import { describe, expect, it } from "vitest";
import {
  quotaPressureLevel, recordTrustEvent, clearTrustSubject, recordQuotaPressure,
  listTrustEvents, trustUnreadCount, markTrustEventRead, recordSecurityEvent, listSecurityEvents,
} from "../../src/lib/trustEvents.js";

// Minimal adapter over arrays, shaped like the db driver (get/all/run/exec).
function fakeDb() {
  const trust = [];
  const sec = [];
  let tid = 0;
  let sid = 0;
  return {
    exec() {},
    get(sql, params = []) {
      if (sql.includes("FROM trustEvents WHERE kind")) {
        const row = [...trust].reverse().find((r) => r.kind === params[0] && (r.subject || "") === params[1] && r.level === params[2] && r.read === 0);
        return row ? { id: row.id } : undefined;
      }
      if (sql.includes("COUNT(*) as c FROM trustEvents")) return { c: trust.filter((r) => r.read === 0).length };
      if (sql.includes("COUNT(*) as c FROM securityLog")) return { c: sec.filter((r) => r.event === "login-failed" && r.ip === params[0] && r.createdAt >= params[1]).length };
      return undefined;
    },
    all(sql, params = []) {
      if (sql.includes("FROM trustEvents")) {
        let rows = [...trust].sort((a, b) => b.id - a.id);
        if (sql.includes("WHERE read = 0")) rows = rows.filter((r) => r.read === 0);
        return rows.slice(0, params[0]);
      }
      if (sql.includes("FROM securityLog")) return [...sec].sort((a, b) => b.id - a.id).slice(0, params[0]);
      return [];
    },
    run(sql, params = []) {
      if (sql.startsWith("INSERT INTO trustEvents")) { trust.push({ id: ++tid, kind: params[0], level: params[1], subject: params[2], title: params[3], detail: params[4], createdAt: params[5], read: 0 }); return { lastInsertRowid: tid }; }
      if (sql.startsWith("UPDATE trustEvents SET read = 1 WHERE kind")) { let n = 0; for (const r of trust) if (r.kind === params[0] && (r.subject || "") === params[1] && r.read === 0) { r.read = 1; n++; } return { changes: n }; }
      if (sql.startsWith("UPDATE trustEvents SET read = 1 WHERE id")) { const r = trust.find((x) => x.id === params[0]); if (r && r.read === 0) { r.read = 1; return { changes: 1 }; } return { changes: 0 }; }
      if (sql.startsWith("UPDATE trustEvents SET read = 1 WHERE read")) { let n = 0; for (const r of trust) if (r.read === 0) { r.read = 1; n++; } return { changes: n }; }
      if (sql.startsWith("INSERT INTO securityLog")) { sec.push({ id: ++sid, event: params[0], ip: params[1], userAgent: params[2], detail: params[3], breach: params[4], createdAt: params[5] }); return { lastInsertRowid: sid }; }
      return {};
    },
  };
}

describe("quotaPressureLevel", () => {
  it("warns at 90%, critical at cap, silent below", () => {
    expect(quotaPressureLevel(89, 100)).toBeNull();
    expect(quotaPressureLevel(90, 100)).toBe("warn");
    expect(quotaPressureLevel(99, 100)).toBe("warn");
    expect(quotaPressureLevel(100, 100)).toBe("critical");
    expect(quotaPressureLevel(5, 0)).toBeNull();
    expect(quotaPressureLevel(5, null)).toBeNull();
  });
});

describe("trust inbox dedupe + re-arm", () => {
  it("suppresses duplicates while unread, records again after clearing", () => {
    const db = fakeDb();
    recordQuotaPressure(db, "key-a", 95, 100);
    recordQuotaPressure(db, "key-a", 96, 100);
    expect(trustUnreadCount(db)).toBe(1);
    recordQuotaPressure(db, "key-a", 10, 100); // clears + re-arms
    expect(trustUnreadCount(db)).toBe(0);
    recordQuotaPressure(db, "key-a", 95, 100);
    expect(trustUnreadCount(db)).toBe(1);
    const [ev] = listTrustEvents(db, { unreadOnly: true });
    expect(ev.level).toBe("warn");
    expect(markTrustEventRead(db, ev.id)).toBe(true);
    expect(trustUnreadCount(db)).toBe(0);
  });
});

describe("security log breach flag", () => {
  it("flags the 5th failed login from one IP and posts a trust event", () => {
    const db = fakeDb();
    for (let i = 0; i < 4; i++) recordSecurityEvent(db, { event: "login-failed", ip: "1.2.3.4" });
    recordSecurityEvent(db, { event: "login-failed", ip: "1.2.3.4" });
    const events = listSecurityEvents(db);
    expect(events.find((e) => e.breach)).toBeTruthy();
    expect(trustUnreadCount(db)).toBe(1);
  });
});
