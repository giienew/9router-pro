// Spam / Abuse client attribution — pure helpers (no Node imports, so
// server recorders and the dashboard client can share them).
// - Client IP: same trust rules as getClientIp (src/lib/auth/loginLimiter.js)
//   but over a headers bag, because chat recording only has the plain-object
//   headers from clientRawRequest (Object.fromEntries(request.headers)).
//   Forwarding headers count only with custom-server.js peer proof
//   (x-9r-peer-token); without it the IP is "unknown".
// - Country: cf-ipcountry when present AND peer-proved, else "unknown".
//   No GeoIP DB, no per-request lookup.
// - Flag: emoji regional indicators derived from the country code — no
//   external image dependency, works offline.
// - Masked keys ONLY: buildClientMeta masks with the shared maskApiKey;
//   a full API key must never reach a log row, a ranking payload, or the UI.
import { maskApiKey } from "./maskApiKey.js";

export const UNKNOWN_IP = "unknown";
export const UNKNOWN_COUNTRY = "unknown";

// Header lookup that works for both a Fetch Headers object (.get) and a
// plain object (clientRawRequest.headers). Header names are case-insensitive.
export function headerValue(headers, name) {
  if (!headers) return null;
  try {
    if (typeof headers.get === "function") {
      const v = headers.get(name);
      return v == null ? null : String(v);
    }
  } catch { /* fall through to plain-object lookup */ }
  const lower = String(name).toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === lower) return v == null ? null : String(v);
  }
  return null;
}

export function normalizeIp(ip) {
  if (!ip || typeof ip !== "string") return UNKNOWN_IP;
  const t = ip.trim().toLowerCase();
  return t || UNKNOWN_IP;
}

// IPv4 dotted quad, or IPv6 (contains a colon). Anything else — hostnames,
// garbage, "unknown" — is not blockable: blocking "unknown" would block
// every request whose IP could not be resolved, including local traffic.
export function isBlockableIp(ip) {
  const n = normalizeIp(ip);
  if (n === UNKNOWN_IP) return false;
  if (/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(n)) return true;
  if (n.includes(":") && /^[0-9a-f:]+(\.\d+\.\d+\.\d+\.\d+)?$/.test(n)) return true;
  return false;
}

// True when custom-server.js proved it vetted these headers: it stamps
// x-9r-peer-token (a per-process secret) on every request it proxies, and
// strips any client-forged forwarding header first. Without that proof the
// headers are attacker-supplied input. Mirrors hasTrustedPeerHeaders
// (src/lib/auth/trustedPeer.js) over a headers bag.
export function hasPeerProof(headers) {
  const token = typeof process !== "undefined" ? process.env?.NINEROUTER_PEER_TOKEN : null;
  if (!token) return false;
  return headerValue(headers, "x-9r-peer-token") === token;
}

// Same trust order as getClientIp (src/lib/auth/loginLimiter.js, hardened
// by audit item 6g), over a headers bag:
// 1. x-9r-real-ip / cf-connecting-ip — ONLY with peer proof. In production
//    custom-server.js strips an unvouched cf-connecting-ip and always
//    stamps the token, so vouched requests keep working; a direct client
//    cannot forge its way into another IP's bucket.
// 2. x-forwarded-for first entry — only when TRUST_PROXY is explicitly on.
// Otherwise "unknown": a spoofable header must never mint a real IP bucket.
export function clientIpFromHeaders(headers) {
  if (hasPeerProof(headers)) {
    const realIp = headerValue(headers, "x-9r-real-ip");
    if (realIp) return normalizeIp(realIp);
    const cfIp = headerValue(headers, "cf-connecting-ip");
    if (cfIp) return normalizeIp(cfIp);
  }
  if (typeof process !== "undefined" && process.env?.TRUST_PROXY === "true") {
    const xff = headerValue(headers, "x-forwarded-for");
    if (xff) return normalizeIp(xff.split(",")[0]);
  }
  return UNKNOWN_IP;
}

// cf-ipcountry is display-only (the flag), but it is just as forgeable as
// cf-connecting-ip, so it needs the same peer proof. Without it: "unknown".
export function countryFromHeaders(headers) {
  if (!hasPeerProof(headers)) return UNKNOWN_COUNTRY;
  const raw = headerValue(headers, "cf-ipcountry");
  if (!raw) return UNKNOWN_COUNTRY;
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : UNKNOWN_COUNTRY;
}

// Regional-indicator flag emoji for an ISO country code. Unknown, empty,
// or malformed codes render as "" — the UI falls back to a globe.
export function countryFlag(code) {
  if (!code || typeof code !== "string") return "";
  const c = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return "";
  const base = 0x1f1e6;
  return String.fromCodePoint(base + (c.charCodeAt(0) - 65), base + (c.charCodeAt(1) - 65));
}

// One call for recorders: { clientIp, country, apiKeyMasked }. The full key
// is masked here, at record time — never stored or displayed raw.
export function buildClientMeta(headers, apiKey) {
  return {
    clientIp: clientIpFromHeaders(headers),
    country: countryFromHeaders(headers),
    apiKeyMasked: maskApiKey(apiKey),
  };
}

// A usage/request row counts as an error unless it completed cleanly.
// Stored statuses: "ok" / "success" / "200" on success; "error" on chatCore
// failures; "FAILED <code>" on requestDetails error rows; numeric HTTP codes.
export function isErrorStatus(status) {
  if (status == null) return false;
  const s = String(status).trim().toLowerCase();
  if (!s) return false;
  if (s === "ok" || s === "success" || s === "200") return false;
  return true;
}

export function is429Status(status) {
  if (status == null) return false;
  const s = String(status).trim().toLowerCase();
  if (s === "429" || s === "failed 429") return true;
  if (s === "rate_limited" || s === "rate-limit" || s === "too_many_requests") return true;
  // requestDetails error rows carry the upstream code in data.response.status
  return false;
}

function rankBucket(map, key, row) {
  let b = map.get(key);
  if (!b) {
    b = { requests: 0, errors: 0, rate429: 0, firstSeen: row.timestamp, lastSeen: row.timestamp };
    map.set(key, b);
  }
  b.requests += 1;
  if (isErrorStatus(row.status)) b.errors += 1;
  if (is429Status(row.status) || row.is429) b.rate429 += 1;
  if (row.timestamp && (!b.firstSeen || row.timestamp < b.firstSeen)) b.firstSeen = row.timestamp;
  if (row.timestamp && (!b.lastSeen || row.timestamp > b.lastSeen)) b.lastSeen = row.timestamp;
  return b;
}

function sortBuckets(list) {
  return list.sort((a, b) =>
    (b.requests - a.requests) || (b.errors - a.errors) || (b.rate429 - a.rate429) ||
    String(b.lastSeen || "").localeCompare(String(a.lastSeen || "")));
}

// Pure ranking aggregation over already-read rows:
//   { clientIp, country, apiKeyMasked, status, timestamp, is429? }
// Returns { byIp, byKey, totals }. Rows without an IP group under
// "unknown"; rows without a key group under "local-no-key". No full key
// ever enters — callers must pass the masked form only.
export function aggregateSpamRanking(rows, { limit = 50 } = {}) {
  const byIpMap = new Map();
  const byKeyMap = new Map();
  const seenIps = new Set();
  const seenKeys = new Set();
  let errors = 0;
  let rate429 = 0;
  for (const row of rows || []) {
    const ip = normalizeIp(row?.clientIp) || UNKNOWN_IP;
    const country = (row?.country && /^[A-Za-z]{2}$/.test(String(row.country).trim()))
      ? String(row.country).trim().toUpperCase()
      : UNKNOWN_COUNTRY;
    const key = row?.apiKeyMasked || "local-no-key";
    const ipBucket = rankBucket(byIpMap, ip, row);
    // Keep the first real country seen for the IP; upgrade an "unknown"
    // placeholder when a later row carries a real one.
    if (ipBucket.country === undefined || ipBucket.country === UNKNOWN_COUNTRY) ipBucket.country = country;
    rankBucket(byKeyMap, key, row);
    seenIps.add(ip);
    seenKeys.add(key);
    if (isErrorStatus(row?.status)) errors += 1;
    if (is429Status(row?.status) || row?.is429) rate429 += 1;
  }
  const byIp = sortBuckets([...byIpMap.entries()].map(([ip, b]) => ({
    ip,
    country: b.country || UNKNOWN_COUNTRY,
    flag: countryFlag(b.country || UNKNOWN_COUNTRY),
    requests: b.requests, errors: b.errors, rate429: b.rate429,
    firstSeen: b.firstSeen || null, lastSeen: b.lastSeen || null,
  }))).slice(0, limit).map((r, i) => ({ rank: i + 1, ...r }));
  const byKey = sortBuckets([...byKeyMap.entries()].map(([apiKeyMasked, b]) => ({
    apiKeyMasked,
    requests: b.requests, errors: b.errors, rate429: b.rate429,
    firstSeen: b.firstSeen || null, lastSeen: b.lastSeen || null,
  }))).slice(0, limit).map((r, i) => ({ rank: i + 1, ...r }));
  return {
    byIp,
    byKey,
    totals: {
      requests: (rows || []).length, errors, rate429,
      uniqueIps: seenIps.size, uniqueKeys: seenKeys.size,
    },
  };
}
