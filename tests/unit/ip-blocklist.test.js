// IP blocklist + spam ranking — integration against a throwaway DATA_DIR.
// Proves: block/unblock persist in SQLite (survives restarts), a blocked IP
// gets 403 from withKeyAdmission BEFORE the provider handler runs, a
// non-blocked IP passes through, unblock restores access, the dashboard
// login route never consults the blocklist, and getSpamRanking returns
// real rows from seeded usage/request-detail data (masked keys only).
// One temp DB per file: the DB driver is a process singleton, so a fresh
// DATA_DIR per test would silently keep pointing at the first dir.
// Requests carry the custom-server peer token (audit 6g trust model):
// forwarding headers only count when vouched, same as getClientIp.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Route wiring is verified with mocked Next request-context bits only —
// the route's own logic (auth guard + ranking lib) runs for real.
let authOk = true;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "dashboard-token" }) }),
}));
vi.mock("@/lib/auth/dashboardSession.js", () => ({
  verifyDashboardAuthToken: async () => authOk,
}));

const PEER_TOKEN = "test-peer-secret";
const savedPeerToken = process.env.NINEROUTER_PEER_TOKEN;
const savedDataDir = process.env.DATA_DIR;
process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;

let tempDir;
let db;
let spam;

const FULL_KEY_A = "sk-test-spamkey-aaaa-0123456789";
const FULL_KEY_B = "sk-test-spamkey-bbbb-9876543210";

function reqWithIp(ip, { peer = true } = {}) {
  const headers = {};
  if (ip) headers["cf-connecting-ip"] = ip;
  if (peer) headers["x-9r-peer-token"] = PEER_TOKEN;
  return new Request("http://localhost/v1/chat/completions", { method: "POST", headers });
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-spam-"));
  process.env.DATA_DIR = tempDir;
  db = await import("@/lib/db/index.js");
  await db.initDb();
  spam = await import("@/lib/spamAbuse.js");
});

afterAll(() => {
  if (savedDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = savedDataDir;
  if (savedPeerToken === undefined) delete process.env.NINEROUTER_PEER_TOKEN;
  else process.env.NINEROUTER_PEER_TOKEN = savedPeerToken;
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

describe("IP blocklist storage (kv scope blockedIps)", () => {
  it("blocks, lists, and unblocks an IP", async () => {
    expect(await spam.isIpBlocked("203.0.113.7")).toBe(false);
    const entry = await spam.blockIp("203.0.113.7", { country: "ID" });
    expect(entry.ip).toBe("203.0.113.7");
    expect(entry.country).toBe("ID");
    expect(await spam.isIpBlocked("203.0.113.7")).toBe(true);
    const list = await spam.listBlockedIps();
    expect(list.find((b) => b.ip === "203.0.113.7")).toMatchObject({ ip: "203.0.113.7", country: "ID", flag: "🇮🇩" });
    expect(await spam.unblockIp("203.0.113.7")).toBe(true);
    expect(await spam.isIpBlocked("203.0.113.7")).toBe(false);
    expect(await spam.listBlockedIps()).not.toContainEqual(expect.objectContaining({ ip: "203.0.113.7" }));
  });

  it("persists the block in the SQLite file (survives a restart)", async () => {
    await spam.blockIp("192.0.2.55", { country: "US" });
    try {
      // A fresh connection to the same file — what a restarted PM2 process sees.
      const raw = new DatabaseSync(path.join(tempDir, "db", "data.sqlite"));
      try {
        const row = raw.prepare(
          `SELECT value FROM kv WHERE scope = 'blockedIps' AND key = '192.0.2.55'`,
        ).get();
        expect(row).toBeTruthy();
        expect(JSON.parse(row.value).country).toBe("US");
      } finally {
        raw.close();
      }
      expect(await spam.isIpBlocked("192.0.2.55")).toBe(true);
    } finally {
      await spam.unblockIp("192.0.2.55");
    }
  });

  it("refuses to block unknown / malformed IPs", async () => {
    expect(await spam.isIpBlocked("unknown")).toBe(false);
    await expect(spam.blockIp("unknown")).rejects.toThrow("Invalid IP");
    await expect(spam.blockIp("not-an-ip")).rejects.toThrow("Invalid IP");
    expect(await spam.unblockIp("unknown")).toBe(false);
  });

  it("normalizes IPv6 case", async () => {
    await spam.blockIp("2001:DB8::1", { country: "DE" });
    try {
      expect(await spam.isIpBlocked("2001:db8::1")).toBe(true);
    } finally {
      await spam.unblockIp("2001:db8::1");
    }
  });
});

describe("enforceBlockedIp", () => {
  it("returns a generic 403 for a blocked IP", async () => {
    await spam.blockIp("203.0.113.7", { country: "ID" });
    try {
      const res = await spam.enforceBlockedIp(reqWithIp("203.0.113.7"));
      expect(res).not.toBeNull();
      expect(res.status).toBe(403);
      const body = await res.text();
      expect(body).toContain("Access denied");
      expect(body).not.toContain("203.0.113.7");
    } finally {
      await spam.unblockIp("203.0.113.7");
    }
  });

  it("returns null for a non-blocked IP and for an unvouched request", async () => {
    expect(await spam.enforceBlockedIp(reqWithIp("198.51.100.9"))).toBeNull();
    // No peer token: forwarding headers are unvouched, so the IP is
    // "unknown" and can never match the blocklist (fail-closed).
    await spam.blockIp("203.0.113.7", { country: "ID" });
    try {
      expect(await spam.enforceBlockedIp(reqWithIp("203.0.113.7", { peer: false }))).toBeNull();
    } finally {
      await spam.unblockIp("203.0.113.7");
    }
  });
});

describe("withKeyAdmission enforcement", () => {
  it("403s a blocked IP on /v1 before the provider handler runs", async () => {
    const { withKeyAdmission } = await import("../../src/sse/services/keyAdmission.js");
    await spam.blockIp("203.0.113.7", { country: "ID" });
    try {
      const fn = vi.fn(async () => new Response("provider-called"));
      const res = await withKeyAdmission(reqWithIp("203.0.113.7"), fn);
      expect(res.status).toBe(403);
      expect(fn).not.toHaveBeenCalled();
    } finally {
      await spam.unblockIp("203.0.113.7");
    }
  });

  it("lets a non-blocked IP through to the handler", async () => {
    const { withKeyAdmission } = await import("../../src/sse/services/keyAdmission.js");
    const fn = vi.fn(async () => new Response("provider-called"));
    const res = await withKeyAdmission(reqWithIp("198.51.100.9"), fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it("restores access after unblock", async () => {
    const { withKeyAdmission } = await import("../../src/sse/services/keyAdmission.js");
    await spam.blockIp("203.0.113.7", { country: "ID" });
    const fn = vi.fn(async () => new Response("provider-called"));
    expect((await withKeyAdmission(reqWithIp("203.0.113.7"), fn)).status).toBe(403);
    expect(fn).not.toHaveBeenCalled();
    await spam.unblockIp("203.0.113.7");
    const res = await withKeyAdmission(reqWithIp("203.0.113.7"), fn);
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("dashboard login is never gated by the blocklist", () => {
  it("login route and dashboard session never reference the blocklist", async () => {
    const loginRoute = fs.readFileSync(
      new URL("../../src/app/api/auth/login/route.js", import.meta.url), "utf8",
    );
    const session = fs.readFileSync(
      new URL("../../src/lib/auth/dashboardSession.js", import.meta.url), "utf8",
    );
    for (const src of [loginRoute, session]) {
      expect(src).not.toContain("spamAbuse");
      expect(src).not.toContain("enforceBlockedIp");
      expect(src).not.toContain("isIpBlocked");
      expect(src).not.toContain("blockedIps");
    }
    // …while the enforcement point does gate the public API funnel.
    const admission = fs.readFileSync(
      new URL("../../src/sse/services/keyAdmission.js", import.meta.url), "utf8",
    );
    expect(admission).toContain("enforceBlockedIp");
  });
});

describe("getSpamRanking on real seeded rows", () => {
  beforeAll(async () => {
    // Two usage rows from .7 (one ok, one 429) + one ok row from .9,
    // recorded through the real saveRequestUsage path with client meta.
    await db.saveRequestUsage({
      provider: "dahl", model: "deepseek", connectionId: "c1", apiKey: FULL_KEY_A,
      endpoint: "/v1/chat/completions", tokens: { prompt_tokens: 10, completion_tokens: 5 },
      status: "ok", clientIp: "203.0.113.7", country: "ID",
    });
    await db.saveRequestUsage({
      provider: "dahl", model: "deepseek", connectionId: "c1", apiKey: FULL_KEY_A,
      endpoint: "/v1/chat/completions", tokens: { prompt_tokens: 1, completion_tokens: 0 },
      status: "429", clientIp: "203.0.113.7", country: "ID",
    });
    await db.saveRequestUsage({
      provider: "dahl", model: "deepseek", connectionId: "c1", apiKey: FULL_KEY_B,
      endpoint: "/v1/chat/completions", tokens: { prompt_tokens: 3, completion_tokens: 2 },
      status: "ok", clientIp: "198.51.100.9", country: "US",
    });
    // One failed chat request: only a requestDetails error row exists
    // (no usage row — chatCore error paths record details, not usage).
    const { getAdapter } = await import("@/lib/db/driver.js");
    const adapter = await getAdapter();
    adapter.run(
      `INSERT OR REPLACE INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      ["detail-1", new Date().toISOString(), "dahl", "deepseek", "c1", "error", JSON.stringify({
        clientIp: "203.0.113.7", country: "ID", apiKeyMasked: "sk-test-***6789",
        response: { status: 429 },
      })],
    );
  });

  it("returns ranked rows by IP and by masked key with error/429 counts", async () => {
    const ranking = await spam.getSpamRanking({ period: "all" });
    expect(ranking.byIp[0].ip).toBe("203.0.113.7");
    expect(ranking.byIp[0].requests).toBe(3); // 2 usage rows + 1 detail row
    expect(ranking.byIp[0].errors).toBe(2);
    expect(ranking.byIp[0].rate429).toBe(2);
    expect(ranking.byIp[0].country).toBe("ID");
    expect(ranking.byIp[0].flag).toBe("🇮🇩");
    expect(ranking.byIp[0].firstSeen).toBeTruthy();
    expect(ranking.byIp[0].lastSeen).toBeTruthy();
    expect(ranking.byIp[1].ip).toBe("198.51.100.9");
    expect(ranking.byIp[1].requests).toBe(1);
    expect(ranking.totals.requests).toBe(4);
    expect(ranking.totals.errors).toBe(2);
    expect(ranking.totals.rate429).toBe(2);
    // Key A made 3 calls (2 usage + 1 detail); key B made 1.
    expect(ranking.byKey[0].requests).toBe(3);
    expect(ranking.byKey[0].apiKeyMasked).not.toBe(FULL_KEY_A);
    expect(ranking.byKey[1].requests).toBe(1);
    // No full key anywhere in the ranking payload.
    expect(JSON.stringify(ranking)).not.toContain(FULL_KEY_A);
    expect(JSON.stringify(ranking)).not.toContain(FULL_KEY_B);
  });

  it("returns the recent log with flag + IP + masked key", async () => {
    const recent = await spam.getRecentSpamLog({ limit: 10 });
    expect(recent).toHaveLength(3);
    const row = recent.find((r) => r.clientIp === "203.0.113.7" && r.status === "429");
    expect(row).toMatchObject({ country: "ID", flag: "🇮🇩" });
    expect(row.apiKeyMasked).not.toBe(FULL_KEY_A);
    expect(JSON.stringify(recent)).not.toContain(FULL_KEY_A);
    expect(JSON.stringify(recent)).not.toContain(FULL_KEY_B);
  });
});

describe("spam-ranking route wiring (real handler, mocked Next context)", () => {
  it("GET /api/spam-ranking returns real ranked rows for a dashboard session", async () => {
    authOk = true;
    const route = await import("../../src/app/api/spam-ranking/route.js");
    const res = await route.GET(new Request("http://localhost/api/spam-ranking?period=all"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.byIp[0].ip).toBe("203.0.113.7");
    expect(json.byIp[0].requests).toBe(3);
    expect(json.byKey[0].requests).toBe(3);
    expect(json.recent).toHaveLength(3);
    expect(Array.isArray(json.blocked)).toBe(true);
    expect(JSON.stringify(json)).not.toContain(FULL_KEY_A);
    expect(JSON.stringify(json)).not.toContain(FULL_KEY_B);
  });

  it("GET /api/spam-ranking 401s without a dashboard session", async () => {
    authOk = false;
    try {
      const route = await import("../../src/app/api/spam-ranking/route.js");
      const res = await route.GET(new Request("http://localhost/api/spam-ranking?period=all"));
      expect(res.status).toBe(401);
    } finally {
      authOk = true;
    }
  });

  it("POST + DELETE /api/blocked-ips block and unblock through the real route", async () => {
    authOk = true;
    const route = await import("../../src/app/api/blocked-ips/route.js");
    const created = await route.POST(new Request("http://localhost/api/blocked-ips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ip: "192.0.2.99", country: "DE" }),
    }));
    expect(created.status).toBe(201);
    expect(await spam.isIpBlocked("192.0.2.99")).toBe(true);
    const listed = await route.GET();
    expect((await listed.json()).blocked).toContainEqual(
      expect.objectContaining({ ip: "192.0.2.99", country: "DE", flag: "🇩🇪" }),
    );
    const removed = await route.DELETE(new Request("http://localhost/api/blocked-ips?ip=192.0.2.99", { method: "DELETE" }));
    expect(removed.status).toBe(200);
    expect(await spam.isIpBlocked("192.0.2.99")).toBe(false);
    const bad = await route.POST(new Request("http://localhost/api/blocked-ips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ip: "unknown" }),
    }));
    expect(bad.status).toBe(400);
  });
});

