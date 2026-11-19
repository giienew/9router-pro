import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createRequire } from "module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Audit item 5 (pro.29): no secret value — or usable prefix of one — may
// reach a MITM dump file, a dump file name, or a console line.
//
// Isolate MITM dumps: point DATA_DIR at a fresh temp dir BEFORE loading the
// CJS logger (src/mitm/paths.js reads DATA_DIR at require time), so the test
// never writes into the real ~/.9router tree.
const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mitm-redact-"));
process.env.DATA_DIR = TMP_DATA_DIR;

const require = createRequire(import.meta.url);
const logger = require("../../src/mitm/logger.js");
const {
  dumpRequest, createResponseDumper,
  redactHeaders, redactUrl, isSensitivePath,
} = logger;

const DUMP_DIR = path.join(TMP_DATA_DIR, "logs", "mitm");

// Realistic secrets. None of these values, nor any usable prefix, may appear
// in any logger output (file content, file name, or console line).
const BEARER_TOKEN = "sk-live-9f8K2vQ7xR4mT1wZ6pL0aB3cD5eF8gH";
const BEARER = `Bearer ${BEARER_TOKEN}`;
const COOKIE =
  "session=eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoxfQ.abc123def456; " +
  "9r_mimo_login=eyJzZXNzaW9uIjoiazl2bTgxcXoifQ";
const API_KEY = "ak_live_7H3kP9qR2sT5vX8wY1zA4bC6dE0fG";
const SESSION_TOKEN = "FQoGZXIvYXdzEJr//////////wEaDRealSessionToken1234567890";
const GOOGLE_KEY = "AIzaSyD-RealKey-1234567890abcdefghij";
const ALL_SECRETS = [BEARER_TOKEN, COOKIE, API_KEY, SESSION_TOKEN, GOOGLE_KEY];

function assertNoLeak(text, secrets, label) {
  const hay = String(text);
  for (const secret of secrets) {
    expect(hay, `${label}: full secret leaked`).not.toContain(secret);
    // Usable prefixes: first 8 and first 12 chars must not appear either.
    expect(hay, `${label}: 12-char secret prefix leaked`).not.toContain(secret.slice(0, 12));
    expect(hay, `${label}: 8-char secret prefix leaked`).not.toContain(secret.slice(0, 8));
  }
}

function listDumpFiles() {
  return fs.existsSync(DUMP_DIR) ? new Set(fs.readdirSync(DUMP_DIR)) : new Set();
}

beforeAll(() => {
  expect(fs.existsSync(DUMP_DIR)).toBe(true);
});

afterAll(() => {
  fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true });
});

describe("MITM logger redaction (audit item 5)", () => {
  it("redacts Authorization / Cookie / x-api-key / *token* headers in dumpRequest", () => {
    const req = {
      method: "POST",
      url: "/v1beta/models/gemini-3.8-flash-medium:generateContent",
      headers: {
        host: "daily-cloudcode-pa.googleapis.com",
        "content-type": "application/json",
        authorization: BEARER,
        cookie: COOKIE,
        "x-api-key": API_KEY,
        "x-amz-security-token": SESSION_TOKEN,
        "x-request-id": "req-123-safe",
      },
    };
    const body = Buffer.from(JSON.stringify({
      model: "gemini-3.8-flash-medium",
      apiKey: API_KEY,
      messages: [{ role: "user", content: "hello" }],
    }));
    const file = dumpRequest(req, body, "raw");
    expect(file).toBeTruthy();
    const content = fs.readFileSync(file, "utf8");
    assertNoLeak(content, [BEARER_TOKEN, COOKIE, API_KEY, SESSION_TOKEN], "dumpRequest file");
    assertNoLeak(path.basename(file), [BEARER_TOKEN, COOKIE, API_KEY, SESSION_TOKEN], "dumpRequest filename");
    // Redaction markers present, safe fields intact.
    expect(content).toContain("[REDACTED]");
    expect(content).toContain("gemini-3.8-flash-medium");
    expect(content).toContain("req-123-safe");
    expect(content).toContain("hello");
    expect(content).toContain('"content-type": "application/json"');
  });

  it("redacts a credential query param (?key=) in the URL and file name", () => {
    const req = {
      method: "GET",
      url: `/v1/models?key=${GOOGLE_KEY}&alt=json`,
      headers: { host: "generativelanguage.googleapis.com", authorization: BEARER },
    };
    const file = dumpRequest(req, Buffer.from('{"model":"gemini-3.8-flash-medium"}'), "raw");
    expect(file).toBeTruthy();
    const content = fs.readFileSync(file, "utf8");
    assertNoLeak(content, [GOOGLE_KEY, BEARER_TOKEN], "dumpRequest ?key= file");
    assertNoLeak(path.basename(file), [GOOGLE_KEY], "dumpRequest ?key= filename");
    expect(content).toContain("key=[REDACTED]");
    expect(content).toContain("alt=json");
  });

  it("never dumps auth/token paths — dumpRequest returns null, no file", () => {
    for (const url of [
      "/oauth2/v4/token",
      "/v1/auth/login",
      "/api/session/refresh",
      "/v1/models?access_token=ya29.RealAccessToken1234567890",
    ]) {
      const before = listDumpFiles();
      const file = dumpRequest(
        {
          method: "POST",
          url,
          headers: {
            host: "oauth2.googleapis.com",
            authorization: BEARER,
            "content-type": "application/json",
          },
        },
        Buffer.from(JSON.stringify({
          grant_type: "authorization_code",
          code: "4/0ARealAuthCode1234567890",
          client_secret: "GOCSPX-RealClientSecret123456",
        })),
        "raw",
      );
      expect(file, `dumpRequest(${url}) must refuse`).toBeNull();
      expect(listDumpFiles(), `dumpRequest(${url}) must write no file`).toEqual(before);
    }
  });

  it("redacts response headers and Bearer tokens in createResponseDumper output", () => {
    const dumper = createResponseDumper(
      {
        method: "POST",
        url: "/v1beta/models/gemini-3.8-flash-medium:streamGenerateContent",
        headers: { host: "daily-cloudcode-pa.googleapis.com" },
      },
      "passthrough",
    );
    expect(dumper).toBeTruthy();
    dumper.writeHeader(200, {
      "content-type": "application/json",
      "set-cookie": COOKIE,
      "x-api-key": API_KEY,
    });
    dumper.writeChunk(Buffer.from(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "hello world" }] } }],
    })));
    dumper.writeChunk(Buffer.from(`\nnote: leaked token Bearer ${BEARER_TOKEN} in body\n`));
    dumper.end();
    const content = fs.readFileSync(dumper.file, "utf8");
    assertNoLeak(content, [BEARER_TOKEN, COOKIE, API_KEY], "response dump file");
    assertNoLeak(path.basename(dumper.file), [BEARER_TOKEN, COOKIE, API_KEY], "response dump filename");
    expect(content).toContain("hello world");
    expect(content).toContain("[REDACTED]");
  });

  it("createResponseDumper refuses auth/token paths", () => {
    expect(createResponseDumper(
      { method: "POST", url: "/oauth2/v4/token", headers: { host: "oauth2.googleapis.com" } },
      "passthrough",
    )).toBeNull();
  });

  it("redactHeaders keeps safe headers and redacts credential ones (any casing)", () => {
    expect(redactHeaders({
      "Content-Type": "application/json",
      Authorization: BEARER,
      "X-API-KEY": API_KEY,
      "x-amz-security-token": SESSION_TOKEN,
      Cookie: COOKIE,
      "x-request-id": "r1",
    })).toEqual({
      "Content-Type": "application/json",
      Authorization: "[REDACTED]",
      "X-API-KEY": "[REDACTED]",
      "x-amz-security-token": "[REDACTED]",
      Cookie: "[REDACTED]",
      "x-request-id": "r1",
    });
  });

  it("redactUrl redacts credential params and leaves other params alone", () => {
    expect(redactUrl(`/v1/models?key=${GOOGLE_KEY}&alt=json`))
      .toBe("/v1/models?key=[REDACTED]&alt=json");
    expect(redactUrl("/v1/models?alt=json")).toBe("/v1/models?alt=json");
    expect(redactUrl(`/v1/models?api_key=${API_KEY}&page=2`))
      .toBe("/v1/models?api_key=[REDACTED]&page=2");
  });

  it("isSensitivePath flags auth/token paths and clears chat paths", () => {
    for (const url of [
      "/oauth2/v4/token", "/v1/auth/login", "/api/session/refresh",
      "/oauth/authorize", "/v1/models?access_token=x",
    ]) expect(isSensitivePath(url), url).toBe(true);
    for (const url of [
      "/v1beta/models/gemini-3.8-flash-medium:generateContent",
      "/v1beta/models/gemini-3.8-flash-medium:streamGenerateContent",
      "/v1/models?alt=json",
    ]) expect(isSensitivePath(url), url).toBe(false);
  });

  it("log() scrubs a Bearer token out of a console line", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      logger.log(`auth failed for ${BEARER} on retry`);
      expect(spy).toHaveBeenCalled();
      const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
      assertNoLeak(out, [BEARER_TOKEN], "console log line");
      expect(out).toContain("Bearer [REDACTED]");
    } finally {
      spy.mockRestore();
    }
  });

  it("src/proxy.js logs only a boolean for the Cookie header, never its content", () => {
    const proxySrc = fs.readFileSync(
      fileURLToPath(new URL("../../src/proxy.js", import.meta.url)),
      "utf8",
    );
    expect(proxySrc).not.toContain("cookies.slice");
    // No interpolation of the raw cookie value: ${cookies} / ${cookies ? ...}
    // is forbidden; ${cookies.length > 0} (a boolean) is the allowed form.
    expect(proxySrc).not.toMatch(/\$\{cookies(\s*\?|\})/);
    expect(proxySrc).toContain("cookie header present:");
    // The no-session line must carry a boolean, not a prefix of the header.
    const line = proxySrc.split("\n").find((l) => l.includes("[mimo-login] no-session"));
    expect(line).toBeTruthy();
    expect(line).toContain("cookies.length > 0");
  });
});
