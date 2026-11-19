const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { DATA_DIR } = require("./paths");
const { LOG_BLACKLIST_URL_PARTS } = require("./config");

// ── Secret redaction (audit item 5) ──────────────────────────────────
// No secret value — or any usable prefix of one — may reach a dump file or
// a console line. Every byte this module writes passes through the helpers
// below, so the call sites (server.js, handlers/antigravity.js) need no
// changes and the function signatures are unchanged.

const REDACTED = "[REDACTED]";

// Header names that carry credentials, matched case-insensitively. The
// substring patterns cover vendor variants: authorization,
// proxy-authorization, x-api-key, x-goog-api-key, x-amz-security-token,
// x-auth-token, cookie, set-cookie, ...
const SENSITIVE_HEADER_RE =
  /(token|secret|password|passwd|credential|auth|session|cookie|api[-_]?key|apikey|access[-_]?key|private[-_]?key)/i;

function isSensitiveHeaderName(name) {
  return SENSITIVE_HEADER_RE.test(String(name || ""));
}

// Same header object shape back, credential values replaced with [REDACTED].
// Accepts a plain object, a Map, or a Headers instance.
function redactHeaders(headers) {
  if (!headers || typeof headers !== "object") return headers;
  const entries =
    typeof headers.entries === "function" && !Array.isArray(headers)
      ? Array.from(headers.entries())
      : Object.entries(headers);
  const out = {};
  for (const [name, value] of entries) {
    out[name] = isSensitiveHeaderName(name) ? REDACTED : value;
  }
  return out;
}

// Query params whose value is a credential (e.g. Google's ?key= API key).
const SENSITIVE_QUERY_PARAMS = new Set([
  "key", "token", "access_token", "refresh_token", "id_token",
  "api_key", "apikey", "auth", "authorization", "secret",
  "client_secret", "password", "passwd", "session", "sessionid", "code",
]);

// Replace credential query-param values with [REDACTED], keep the rest.
function redactUrl(url) {
  if (!url) return url;
  const str = String(url);
  const q = str.indexOf("?");
  if (q === -1) return str;
  const base = str.slice(0, q + 1);
  const rest = str.slice(q + 1);
  const hashIdx = rest.indexOf("#");
  const query = hashIdx === -1 ? rest : rest.slice(0, hashIdx);
  const hash = hashIdx === -1 ? "" : rest.slice(hashIdx);
  const parts = query.split("&").map((pair) => {
    const eq = pair.indexOf("=");
    const name = eq === -1 ? pair : pair.slice(0, eq);
    let decoded = name;
    try { decoded = decodeURIComponent(name); } catch { /* keep raw */ }
    return SENSITIVE_QUERY_PARAMS.has(decoded.toLowerCase())
      ? `${name}=${REDACTED}`
      : pair;
  });
  return base + parts.join("&") + hash;
}

// Paths whose request/response bodies must NEVER be dumped, even in dev:
// auth / token / login / OAuth / session endpoints. A body on those paths
// is (or carries) credential material, and no scrub can make it safe to keep.
const SENSITIVE_PATH_RE =
  /(^|\/)(auth|token|login|oauth|signin|sign-in|sign_in|session|callback|refresh|password|reset|verify|api[-_]?key|apikey)([\/?#]|$)/i;

function isSensitivePath(url) {
  if (!url) return false;
  const lower = String(url).toLowerCase();
  if (
    lower.includes("access_token") || lower.includes("refresh_token") ||
    lower.includes("id_token") || lower.includes("client_secret")
  ) return true;
  const path = lower.split("?")[0].split("#")[0];
  if (path.includes("token")) return true;
  return SENSITIVE_PATH_RE.test(path);
}

// JSON keys whose value is a credential.
const SENSITIVE_BODY_KEY_RE =
  /(token|secret|password|passwd|credential|auth|session|cookie|api[-_]?key|apikey|access[-_]?key|private[-_]?key|client[-_]?secret)/i;

// Recursively replace credential values in a parsed JSON body.
function redactValue(value, depth = 0) {
  if (depth > 20) return REDACTED; // absurd nesting — never dump it raw
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_BODY_KEY_RE.test(k) ? REDACTED : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

// Scrub credential patterns out of free text (error strings, raw bodies).
function scrubSensitiveText(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  return text
    // Bearer <token> — the classic leaked credential in error strings.
    .replace(/Bearer\s+[A-Za-z0-9_\-./+=]{8,}/gi, `Bearer ${REDACTED}`)
    // sk-... / sk-proj-... style API keys embedded in free text.
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_\-]{8,}\b/g, REDACTED)
    // JSON credential fields in otherwise-unparsed text.
    .replace(
      /("(?:[^"]*(?:api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|password|passwd|secret|auth[-_]?token))[^"]*"\s*:\s*")[^"]{1,}(")/gi,
      `$1${REDACTED}$2`
    )
    // api_key=... / apikey=... in free text / form bodies.
    .replace(/(api[_-]?key\s*=\s*)([^\s&"']{8,})/gi, `$1${REDACTED}`);
}

function time() {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

const log = (msg) => console.log(`[${time()}] [MITM] ${scrubSensitiveText(String(msg))}`);
const err = (msg) => console.error(`[${time()}] ❌ [MITM] ${scrubSensitiveText(String(msg))}`);

const DUMP_DIR = path.join(DATA_DIR, "logs", "mitm");
if (!fs.existsSync(DUMP_DIR)) fs.mkdirSync(DUMP_DIR, { recursive: true });

// Clear all files inside DUMP_DIR (called on MITM server start to avoid unbounded growth)
function clearDumpDir() {
  try {
    if (!fs.existsSync(DUMP_DIR)) return;
    for (const f of fs.readdirSync(DUMP_DIR)) {
      try { fs.rmSync(path.join(DUMP_DIR, f), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

const EMPTY_BODY_RE = /^\s*(\{\s*\}|\[\s*\]|null)?\s*$/;

function slugify(s, max = 80) {
  return String(s).replace(/[^a-zA-Z0-9]/g, "_").substring(0, max);
}

function isBlacklisted(url) {
  if (!url) return false;
  return LOG_BLACKLIST_URL_PARTS.some(part => url.includes(part));
}

// Decode body buffer based on content-encoding header
function decodeBody(buf, encoding) {
  if (!buf || buf.length === 0) return buf;
  try {
    const enc = (encoding || "").toLowerCase();
    if (enc.includes("gzip")) return zlib.gunzipSync(buf);
    if (enc.includes("br")) return zlib.brotliDecompressSync(buf);
    if (enc.includes("deflate")) return zlib.inflateSync(buf);
  } catch { /* return raw on failure */ }
  return buf;
}

// Save redacted request: method + url + headers + body. Credential headers
// are replaced, credential query params are replaced (also in the file
// name), credential JSON keys in the body are replaced, and auth/token
// paths are never dumped at all (returns null, like blacklisted URLs).
function dumpRequest(req, bodyBuffer, tag = "raw") {
  if (isBlacklisted(req.url)) return null;
  if (isSensitivePath(req.url)) return null;
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const safeUrl = redactUrl(req.url);
    const slug = slugify((req.headers.host || "") + safeUrl);
    const file = path.join(DUMP_DIR, `${ts}_${tag}_${slug}.req.json`);
    const rawText = (bodyBuffer || Buffer.alloc(0)).toString("utf8");
    let body;
    try {
      const parsed = JSON.parse(rawText);
      body = typeof parsed === "string" ? scrubSensitiveText(parsed) : redactValue(parsed);
    } catch {
      body = scrubSensitiveText(rawText);
    }
    fs.writeFileSync(file, JSON.stringify({
      method: req.method,
      url: safeUrl,
      host: req.headers.host,
      headers: redactHeaders(req.headers),
      body
    }, null, 2));
    return file;
  } catch { return null; }
}

// Buffer-based response dumper — collects chunks then decodes + writes once on end()
// Trade-off: holds response in RAM, but enables gzip/br decoding for readable output.
// Response headers are redacted (set-cookie, auth, *token*, ...) and the
// decoded body text is scrubbed for Bearer / API-key patterns before writing.
// Auth/token paths are never dumped at all (returns null).
function createResponseDumper(req, tag = "raw") {
  if (isBlacklisted(req.url)) return null;
  if (isSensitivePath(req.url)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safeUrl = redactUrl(req.url);
  const slug = slugify((req.headers.host || "") + safeUrl);
  const file = path.join(DUMP_DIR, `${ts}_${tag}_${slug}.res.txt`);
  let status = 0;
  let headers = {};
  const chunks = [];
  return {
    writeHeader: (s, h) => { status = s; headers = h || {}; },
    writeChunk: (chunk) => {
      if (chunk == null) return;
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
    end: () => {
      try {
        const raw = Buffer.concat(chunks);
        const enc = headers["content-encoding"] || headers["Content-Encoding"];
        const decoded = decodeBody(raw, enc);
        const text = scrubSensitiveText(decoded.toString("utf8"));
        // Skip empty / trivially-empty bodies
        if (EMPTY_BODY_RE.test(text)) return;
        // Strip content-encoding since body is now decoded, then redact
        // credential headers (set-cookie, authorization, *token*, ...).
        const cleanHeaders = redactHeaders(headers);
        delete cleanHeaders["content-encoding"];
        delete cleanHeaders["Content-Encoding"];
        const out = `STATUS: ${status}\nHEADERS: ${JSON.stringify(cleanHeaders, null, 2)}\n---BODY---\n${text}`;
        fs.writeFileSync(file, out);
      } catch { /* ignore */ }
    },
    file
  };
}

module.exports = {
  log, err, dumpRequest, createResponseDumper, clearDumpDir,
  redactHeaders, redactUrl, isSensitivePath, scrubSensitiveText,
};
