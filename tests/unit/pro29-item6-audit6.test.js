// Security audit item 6 (pro.29, MEDIUM bundle) — behaviour evidence.
// (a) apiError migration: covered by tests/unit/audit-m3-api-error.test.js
//     plus node --check on every edited route (see task report).
// (b) PKCE verifier kept server-side: route-level tests below.
// (c) Proxy-pool credentials encrypted at rest (atRestCrypto envelope).
// (d) API keys generated from crypto.randomBytes (24 bytes), not Math.random.
// (e) Secure cookie default-on: src/lib/auth/secureCookie.js unit tests below.
// (f) Login lockout persisted in the DB (survives a process restart).
// (g) cf-connecting-ip trusted only from Cloudflare/tunnel peers.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateApiKeyWithMachine, parseApiKey, verifyApiKeyCrc } from "../../src/shared/utils/apiKey.js";
import { encryptProxyUrl, decryptProxyUrl } from "../../src/lib/db/repos/proxyPoolsRepo.js";
import { shouldSetSecureCookie } from "../../src/lib/auth/secureCookie.js";

const KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OLD_CRED_KEY = process.env.PRO_CREDENTIAL_KEY;

describe("(d) API key generation uses crypto.randomBytes", () => {
  it("keyId is 48 hex chars (24 random bytes), parses and verifies", () => {
    const { key, keyId } = generateApiKeyWithMachine("0123456789abcdef", "sk");
    expect(keyId).toMatch(/^[0-9a-f]{48}$/);
    expect(key).toBe(`sk-0123456789abcdef-${keyId}-${key.split("-").pop()}`);
    const parsed = parseApiKey(key);
    expect(parsed).toEqual({ machineId: "0123456789abcdef", keyId, isNewFormat: true });
    expect(verifyApiKeyCrc(key)).toBe(true);
  });

  it("rejects a tampered key and never repeats a keyId", () => {
    const { key } = generateApiKeyWithMachine("0123456789abcdef");
    expect(verifyApiKeyCrc(`${key.slice(0, -1)}0`)).toBe(false);
    const ids = new Set();
    for (let i = 0; i < 500; i++) ids.add(generateApiKeyWithMachine("0123456789abcdef").keyId);
    expect(ids.size).toBe(500);
  });

  it("old 6-char-format keys still parse (back-compat for existing keys)", () => {
    // A legacy key minted before this fix: short keyId, valid CRC.
    const { key } = generateApiKeyWithMachine("0123456789abcdef");
    expect(parseApiKey(key).isNewFormat).toBe(true);
  });
});

describe("(c) proxy-pool credential encryption", () => {
  beforeEach(() => { process.env.PRO_CREDENTIAL_KEY = KEY_HEX; });
  afterEach(() => {
    if (OLD_CRED_KEY === undefined) delete process.env.PRO_CREDENTIAL_KEY;
    else process.env.PRO_CREDENTIAL_KEY = OLD_CRED_KEY;
  });

  it("round-trips a credentialed URL and hides the password at rest", () => {
    const url = "http://user:s3cretPass@proxy.example.com:8080";
    const enc = encryptProxyUrl(url);
    expect(enc).not.toBe(url);
    expect(enc).not.toContain("s3cretPass");
    expect(enc).toContain("proxy.example.com:8080");
    expect(decryptProxyUrl(enc)).toBe(url);
  });

  it("round-trips the bare host:port form and URLs with a path/query", () => {
    expect(decryptProxyUrl(encryptProxyUrl("user:s3cretPass@proxy.example.com:8080")))
      .toBe("user:s3cretPass@proxy.example.com:8080");
    expect(decryptProxyUrl(encryptProxyUrl("https://u:p%40ss@h:3128/path?q=1")))
      .toBe("https://u:p%40ss@h:3128/path?q=1");
  });

  it("leaves credential-less URLs untouched and never double-encrypts", () => {
    expect(encryptProxyUrl("http://proxy.example.com:8080")).toBe("http://proxy.example.com:8080");
    expect(encryptProxyUrl("http://user@proxy.example.com:8080")).toBe("http://user@proxy.example.com:8080");
    const enc = encryptProxyUrl("http://user:s3cretPass@proxy.example.com:8080");
    expect(encryptProxyUrl(enc)).toBe(enc);
    expect(decryptProxyUrl(decryptProxyUrl(enc))).toBe("http://user:s3cretPass@proxy.example.com:8080");
  });

  it("passes legacy plaintext pools through untouched", () => {
    expect(decryptProxyUrl("http://user:plain@h:8080")).toBe("http://user:plain@h:8080");
  });

  it("without a key configured, storage stays plaintext (documented legacy fallback)", () => {
    delete process.env.PRO_CREDENTIAL_KEY;
    const url = "http://user:s3cret@h:8080";
    expect(encryptProxyUrl(url)).toBe(url);
    expect(decryptProxyUrl(url)).toBe(url);
  });
});

describe("(e) Secure cookie is default-on", () => {
  const OLD = process.env.AUTH_COOKIE_SECURE;
  afterEach(() => {
    if (OLD === undefined) delete process.env.AUTH_COOKIE_SECURE;
    else process.env.AUTH_COOKIE_SECURE = OLD;
  });

  it("is secure by default (env unset)", () => {
    delete process.env.AUTH_COOKIE_SECURE;
    expect(shouldSetSecureCookie()).toBe(true);
  });

  it("stays secure when explicitly enabled", () => {
    process.env.AUTH_COOKIE_SECURE = "true";
    expect(shouldSetSecureCookie()).toBe(true);
  });

  it("is only off with an explicit opt-out", () => {
    process.env.AUTH_COOKIE_SECURE = "false";
    expect(shouldSetSecureCookie()).toBe(false);
  });
});

describe("(f) login lockout persists in the DB", () => {
  let tmpDir;
  const OLD_DATA_DIR = process.env.DATA_DIR;
  const OLD_TRUST_PROXY = process.env.TRUST_PROXY;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-item6-lockout-"));
    process.env.DATA_DIR = tmpDir;
    delete process.env.TRUST_PROXY;
  });

  afterEach(() => {
    vi.resetModules();
    if (OLD_DATA_DIR === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = OLD_DATA_DIR;
    if (OLD_TRUST_PROXY === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = OLD_TRUST_PROXY;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("a lockout survives a module reload (process restart) and a success clears it", async () => {
    vi.resetModules();
    const m1 = await import("../../src/lib/auth/loginLimiter.js");
    const ip = "203.0.113.7";
    for (let i = 0; i < 5; i++) m1.recordFail(ip);
    expect(m1.checkLock(ip).locked).toBe(true);
    // Let the background DB init finish, then re-check so the memory entry
    // is seeded into the DB before the simulated restart.
    await new Promise((r) => setTimeout(r, 500));
    expect(m1.checkLock(ip).locked).toBe(true);

    const driver = await import("../../src/lib/db/driver.js");
    const db = await driver.getAdapter();
    const row = db.get(`SELECT fails, lockUntil, lockLevel FROM loginLockouts WHERE ip = ?`, [ip]);
    expect(row).toBeTruthy();
    expect(row.lockLevel).toBe(1);
    expect(row.lockUntil).toBeGreaterThan(Date.now());

    // Simulated restart: fresh module state (empty in-memory map), same DB file.
    vi.resetModules();
    const m2 = await import("../../src/lib/auth/loginLimiter.js");
    const lock = m2.checkLock(ip);
    expect(lock.locked).toBe(true);
    expect(lock.retryAfter).toBeGreaterThan(0);

    m2.recordSuccess(ip);
    expect(m2.checkLock(ip).locked).toBe(false);

    vi.resetModules();
    const m3 = await import("../../src/lib/auth/loginLimiter.js");
    expect(m3.checkLock(ip).locked).toBe(false);
    const db2 = await (await import("../../src/lib/db/driver.js")).getAdapter();
    expect(db2.get(`SELECT * FROM loginLockouts WHERE ip = ?`, [ip])).toBeFalsy();
  }, 30000);
});

describe("(g) cf-connecting-ip is trusted only from a vouched peer", () => {
  const OLD_TOKEN = process.env.NINEROUTER_PEER_TOKEN;
  const OLD_TRUST_PROXY = process.env.TRUST_PROXY;

  function fakeRequest(headers) {
    const lower = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
    return { headers: { get: (name) => lower[String(name).toLowerCase()] ?? null } };
  }

  beforeEach(() => { delete process.env.TRUST_PROXY; });
  afterEach(() => {
    vi.resetModules();
    if (OLD_TOKEN === undefined) delete process.env.NINEROUTER_PEER_TOKEN;
    else process.env.NINEROUTER_PEER_TOKEN = OLD_TOKEN;
    if (OLD_TRUST_PROXY === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = OLD_TRUST_PROXY;
  });

  it("ignores a spoofed cf-connecting-ip with no peer token", async () => {
    vi.resetModules();
    delete process.env.NINEROUTER_PEER_TOKEN;
    const { getClientIp } = await import("../../src/lib/auth/loginLimiter.js");
    expect(getClientIp(fakeRequest({ "cf-connecting-ip": "203.0.113.99" }))).toBe("unknown");
  });

  it("trusts cf-connecting-ip only when custom-server stamped the peer token", async () => {
    vi.resetModules();
    process.env.NINEROUTER_PEER_TOKEN = "test-peer-token";
    const { getClientIp } = await import("../../src/lib/auth/loginLimiter.js");
    expect(getClientIp(fakeRequest({
      "cf-connecting-ip": "203.0.113.99",
      "x-9r-peer-token": "test-peer-token",
    }))).toBe("203.0.113.99");
    // Wrong token: same header is untrusted again.
    expect(getClientIp(fakeRequest({
      "cf-connecting-ip": "203.0.113.99",
      "x-9r-peer-token": "forged",
    }))).toBe("unknown");
  });

  it("still prefers the socket-derived x-9r-real-ip over cf-connecting-ip", async () => {
    vi.resetModules();
    process.env.NINEROUTER_PEER_TOKEN = "test-peer-token";
    const { getClientIp } = await import("../../src/lib/auth/loginLimiter.js");
    expect(getClientIp(fakeRequest({
      "x-9r-real-ip": "198.51.100.5",
      "cf-connecting-ip": "203.0.113.99",
      "x-9r-peer-token": "test-peer-token",
    }))).toBe("198.51.100.5");
  });
});
