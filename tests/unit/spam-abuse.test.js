// Spam / Abuse ranking — pure helpers (src/shared/utils/clientMeta.js).
// Covers: country-code → flag emoji (incl. unknown), client IP + country
// extraction from headers, masked-key recording (no full key in the record),
// and the ranking aggregation (grouping by IP and by masked key, volume +
// error/429 ordering, first/last seen).
import { describe, it, expect, afterEach } from "vitest";
import {
  aggregateSpamRanking,
  buildClientMeta,
  clientIpFromHeaders,
  countryFlag,
  countryFromHeaders,
  headerValue,
  is429Status,
  isBlockableIp,
  isErrorStatus,
  normalizeIp,
} from "../../src/shared/utils/clientMeta.js";

const FULL_KEY = "sk-test-spam-abuse-0123456789abcdef";

describe("countryFlag", () => {
  it("maps US and ID to their flags", () => {
    expect(countryFlag("US")).toBe("🇺🇸");
    expect(countryFlag("ID")).toBe("🇮🇩");
    expect(countryFlag("GB")).toBe("🇬🇧");
  });
  it("is case-insensitive", () => {
    expect(countryFlag("us")).toBe("🇺🇸");
  });
  it("returns empty for unknown / malformed codes", () => {
    expect(countryFlag("unknown")).toBe("");
    expect(countryFlag("")).toBe("");
    expect(countryFlag(null)).toBe("");
    expect(countryFlag("USA")).toBe("");
    expect(countryFlag("U1")).toBe("");
  });
});

describe("headerValue", () => {
  it("reads a Fetch Headers object", () => {
    const h = new Headers({ "CF-IPCountry": "ID" });
    expect(headerValue(h, "cf-ipcountry")).toBe("ID");
  });
  it("reads a plain object case-insensitively (clientRawRequest.headers)", () => {
    expect(headerValue({ "CF-Connecting-IP": "1.2.3.4" }, "cf-connecting-ip")).toBe("1.2.3.4");
    expect(headerValue({ "cf-connecting-ip": "1.2.3.4" }, "CF-Connecting-IP")).toBe("1.2.3.4");
  });
  it("returns null when absent", () => {
    expect(headerValue({}, "cf-ipcountry")).toBeNull();
    expect(headerValue(null, "cf-ipcountry")).toBeNull();
  });
});

describe("clientIpFromHeaders", () => {
  const savedPeer = process.env.NINEROUTER_PEER_TOKEN;
  const savedTrust = process.env.TRUST_PROXY;
  afterEach(() => {
    if (savedPeer === undefined) delete process.env.NINEROUTER_PEER_TOKEN;
    else process.env.NINEROUTER_PEER_TOKEN = savedPeer;
    if (savedTrust === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = savedTrust;
  });

  // Hardened trust (audit 6g, same as getClientIp): forwarding headers
  // count only with custom-server.js peer proof (x-9r-peer-token). A bare
  // cf-connecting-ip from a direct client is ignored.
  it("ignores a bare cf-connecting-ip without peer proof", () => {
    delete process.env.NINEROUTER_PEER_TOKEN;
    expect(clientIpFromHeaders({ "cf-connecting-ip": "203.0.113.7" })).toBe("unknown");
  });
  it("trusts cf-connecting-ip with peer proof", () => {
    process.env.NINEROUTER_PEER_TOKEN = "peer-secret";
    expect(clientIpFromHeaders({ "cf-connecting-ip": "203.0.113.7", "x-9r-peer-token": "peer-secret" })).toBe("203.0.113.7");
    expect(clientIpFromHeaders({ "cf-connecting-ip": "203.0.113.7", "x-9r-peer-token": "wrong" })).toBe("unknown");
  });
  it("trusts x-9r-real-ip only with the matching peer token", () => {
    process.env.NINEROUTER_PEER_TOKEN = "peer-secret";
    expect(clientIpFromHeaders({ "x-9r-real-ip": "6.6.6.6", "x-9r-peer-token": "peer-secret" })).toBe("6.6.6.6");
    expect(clientIpFromHeaders({ "x-9r-real-ip": "6.6.6.6", "x-9r-peer-token": "wrong" })).toBe("unknown");
  });
  it("ignores x-forwarded-for unless TRUST_PROXY is on", () => {
    delete process.env.TRUST_PROXY;
    expect(clientIpFromHeaders({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" })).toBe("unknown");
    process.env.TRUST_PROXY = "true";
    expect(clientIpFromHeaders({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" })).toBe("9.9.9.9");
  });
  it("returns unknown with no usable header", () => {
    expect(clientIpFromHeaders({})).toBe("unknown");
  });
});

describe("countryFromHeaders", () => {
  const savedPeer = process.env.NINEROUTER_PEER_TOKEN;
  afterEach(() => {
    if (savedPeer === undefined) delete process.env.NINEROUTER_PEER_TOKEN;
    else process.env.NINEROUTER_PEER_TOKEN = savedPeer;
  });
  const vouched = { "cf-ipcountry": "id", "x-9r-peer-token": "peer-secret" };

  it("reads cf-ipcountry upper-cased with peer proof", () => {
    process.env.NINEROUTER_PEER_TOKEN = "peer-secret";
    expect(countryFromHeaders(vouched)).toBe("ID");
  });
  it("falls back to unknown without peer proof or with garbage", () => {
    delete process.env.NINEROUTER_PEER_TOKEN;
    expect(countryFromHeaders({ "cf-ipcountry": "id" })).toBe("unknown");
    process.env.NINEROUTER_PEER_TOKEN = "peer-secret";
    expect(countryFromHeaders({})).toBe("unknown");
    expect(countryFromHeaders({ "cf-ipcountry": "XX1", "x-9r-peer-token": "peer-secret" })).toBe("unknown");
  });
});

describe("buildClientMeta (masking)", () => {
  const savedPeer = process.env.NINEROUTER_PEER_TOKEN;
  afterEach(() => {
    if (savedPeer === undefined) delete process.env.NINEROUTER_PEER_TOKEN;
    else process.env.NINEROUTER_PEER_TOKEN = savedPeer;
  });

  it("records IP + country + masked key — never the full key", () => {
    process.env.NINEROUTER_PEER_TOKEN = "peer-secret";
    const meta = buildClientMeta(
      { "cf-connecting-ip": "203.0.113.7", "cf-ipcountry": "ID", "x-9r-peer-token": "peer-secret" },
      FULL_KEY,
    );
    expect(meta.clientIp).toBe("203.0.113.7");
    expect(meta.country).toBe("ID");
    expect(meta.apiKeyMasked).toBe("sk-test-***cdef");
    expect(JSON.stringify(meta)).not.toContain(FULL_KEY);
    expect(JSON.stringify(meta)).not.toContain("0123456789abcdef");
  });
  it("handles missing key and headers", () => {
    const meta = buildClientMeta(null, null);
    expect(meta.clientIp).toBe("unknown");
    expect(meta.country).toBe("unknown");
    expect(meta.apiKeyMasked).toBeNull();
  });
});

describe("normalizeIp / isBlockableIp", () => {
  it("normalizes case and whitespace", () => {
    expect(normalizeIp("  2001:DB8::1 ")).toBe("2001:db8::1");
    expect(normalizeIp("")).toBe("unknown");
  });
  it("accepts IPv4 and IPv6, rejects unknown and garbage", () => {
    expect(isBlockableIp("203.0.113.7")).toBe(true);
    expect(isBlockableIp("2001:db8::1")).toBe(true);
    expect(isBlockableIp("unknown")).toBe(false);
    expect(isBlockableIp("")).toBe(false);
    expect(isBlockableIp("not-an-ip")).toBe(false);
    expect(isBlockableIp("example.com")).toBe(false);
  });
});

describe("isErrorStatus / is429Status", () => {
  it("treats ok/success/200 as clean", () => {
    expect(isErrorStatus("ok")).toBe(false);
    expect(isErrorStatus("success")).toBe(false);
    expect(isErrorStatus("200")).toBe(false);
    expect(isErrorStatus(null)).toBe(false);
  });
  it("treats error and FAILED codes as errors", () => {
    expect(isErrorStatus("error")).toBe(true);
    expect(isErrorStatus("FAILED 429")).toBe(true);
    expect(isErrorStatus("500")).toBe(true);
  });
  it("detects 429s", () => {
    expect(is429Status("429")).toBe(true);
    expect(is429Status("FAILED 429")).toBe(true);
    expect(is429Status("rate_limited")).toBe(true);
    expect(is429Status("500")).toBe(false);
    expect(is429Status("ok")).toBe(false);
  });
});

describe("aggregateSpamRanking", () => {
  const rows = [
    { clientIp: "203.0.113.7", country: "ID", apiKeyMasked: "sk-aaaa***1111", status: "ok", timestamp: "2026-11-19T10:00:00.000Z" },
    { clientIp: "203.0.113.7", country: "ID", apiKeyMasked: "sk-aaaa***1111", status: "429", timestamp: "2026-11-19T10:01:00.000Z" },
    { clientIp: "203.0.113.7", country: "ID", apiKeyMasked: "sk-aaaa***1111", status: "error", timestamp: "2026-11-19T10:02:00.000Z" },
    { clientIp: "198.51.100.9", country: "US", apiKeyMasked: "sk-bbbb***2222", status: "ok", timestamp: "2026-11-19T09:00:00.000Z" },
    { clientIp: "198.51.100.9", country: "US", apiKeyMasked: "sk-bbbb***2222", status: "ok", timestamp: "2026-11-19T09:05:00.000Z" },
    { clientIp: "198.51.100.9", country: "US", apiKeyMasked: "sk-aaaa***1111", status: "ok", timestamp: "2026-11-19T09:06:00.000Z" },
    { clientIp: null, country: null, apiKeyMasked: null, status: "ok", timestamp: "2026-11-19T08:00:00.000Z" },
  ];

  it("groups by IP, orders by volume, and counts errors/429s", () => {
    const { byIp, totals } = aggregateSpamRanking(rows);
    expect(byIp[0].ip).toBe("203.0.113.7");
    expect(byIp[0].rank).toBe(1);
    expect(byIp[0].requests).toBe(3);
    expect(byIp[0].errors).toBe(2);
    expect(byIp[0].rate429).toBe(1);
    expect(byIp[0].country).toBe("ID");
    expect(byIp[0].flag).toBe("🇮🇩");
    expect(byIp[0].firstSeen).toBe("2026-11-19T10:00:00.000Z");
    expect(byIp[0].lastSeen).toBe("2026-11-19T10:02:00.000Z");
    expect(byIp[1].ip).toBe("198.51.100.9");
    expect(byIp[1].requests).toBe(3);
    expect(byIp[1].errors).toBe(0);
    expect(totals.requests).toBe(7);
    expect(totals.errors).toBe(2);
    expect(totals.rate429).toBe(1);
    expect(totals.uniqueIps).toBe(3);
  });

  it("groups unknown IPs and local (no-key) rows separately", () => {
    const { byIp, byKey } = aggregateSpamRanking(rows);
    const unknown = byIp.find((r) => r.ip === "unknown");
    expect(unknown.requests).toBe(1);
    expect(unknown.flag).toBe("");
    const local = byKey.find((r) => r.apiKeyMasked === "local-no-key");
    expect(local.requests).toBe(1);
  });

  it("groups by masked key across IPs", () => {
    const { byKey } = aggregateSpamRanking(rows);
    // sk-aaaa***1111 made 4 calls (3 from .7, 1 from .9); sk-bbbb***2222 made 2.
    expect(byKey[0].apiKeyMasked).toBe("sk-aaaa***1111");
    expect(byKey[0].requests).toBe(4);
    expect(byKey[0].errors).toBe(2);
    expect(byKey[0].rate429).toBe(1);
    expect(byKey[0].firstSeen).toBe("2026-11-19T09:06:00.000Z");
    expect(byKey[0].lastSeen).toBe("2026-11-19T10:02:00.000Z");
    expect(byKey[1].apiKeyMasked).toBe("sk-bbbb***2222");
    expect(byKey[1].requests).toBe(2);
  });

  it("respects the limit", () => {
    const { byIp, byKey } = aggregateSpamRanking(rows, { limit: 1 });
    expect(byIp).toHaveLength(1);
    expect(byKey).toHaveLength(1);
  });

  it("never exposes a full key", () => {
    const { byIp, byKey } = aggregateSpamRanking(rows);
    expect(JSON.stringify({ byIp, byKey })).not.toContain(FULL_KEY);
  });
});
