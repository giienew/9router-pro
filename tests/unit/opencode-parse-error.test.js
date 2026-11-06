import { describe, it, expect } from "vitest";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { OpenCodeZenExecutor } from "../../open-sse/executors/opencode-zen.js";

const FREE_LIMIT_BODY = {
  error: {
    code: "FreeUsageLimitError",
    message: "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go",
  },
};

function withResetFields(fields) {
  return JSON.stringify({ error: { ...FREE_LIMIT_BODY.error, ...fields } });
}

describe("OpenCode parseError", () => {
  it("parses resets_at unix seconds into resetsAtMs on opencode", () => {
    const executor = new OpenCodeExecutor();
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const parsed = executor.parseError({ status: 429 }, withResetFields({ resets_at: resetsAt }));
    expect(parsed.status).toBe(429);
    expect(parsed.message).toContain("Free usage limit reached");
    expect(parsed.resetsAtMs).toBe(resetsAt * 1000);
  });

  it("parses resets_in_seconds into resetsAtMs on opencode", () => {
    const executor = new OpenCodeExecutor();
    const before = Date.now();
    const parsed = executor.parseError({ status: 429 }, withResetFields({ resets_in_seconds: 1800 }));
    const after = Date.now();
    expect(parsed.status).toBe(429);
    expect(parsed.resetsAtMs).toBeGreaterThanOrEqual(before + 1800 * 1000);
    expect(parsed.resetsAtMs).toBeLessThanOrEqual(after + 1800 * 1000);
  });

  it("prefers resets_at over resets_in_seconds when both are present", () => {
    const executor = new OpenCodeExecutor();
    const resetsAt = Math.floor(Date.now() / 1000) + 7200;
    const parsed = executor.parseError(
      { status: 429 },
      withResetFields({ resets_at: resetsAt, resets_in_seconds: 60 }),
    );
    expect(parsed.resetsAtMs).toBe(resetsAt * 1000);
  });

  it("parses retry-after header seconds when the body carries no reset fields", () => {
    const executor = new OpenCodeExecutor();
    const bodyText = JSON.stringify(FREE_LIMIT_BODY);
    const response = new Response(bodyText, { status: 429, headers: { "retry-after": "120" } });
    const before = Date.now();
    const parsed = executor.parseError(response, bodyText);
    const after = Date.now();
    expect(parsed.status).toBe(429);
    expect(parsed.resetsAtMs).toBeGreaterThanOrEqual(before + 120 * 1000);
    expect(parsed.resetsAtMs).toBeLessThanOrEqual(after + 120 * 1000);
  });

  it("parses retry-after header HTTP-date when the body carries no reset fields", () => {
    const executor = new OpenCodeExecutor();
    const resetDate = new Date(Date.now() + 45 * 60 * 1000);
    const bodyText = JSON.stringify(FREE_LIMIT_BODY);
    const response = new Response(bodyText, { status: 429, headers: { "retry-after": resetDate.toUTCString() } });
    const parsed = executor.parseError(response, bodyText);
    expect(parsed.status).toBe(429);
    // HTTP-date headers carry second precision only, so the parsed reset is
    // the reset date truncated to whole seconds.
    expect(parsed.resetsAtMs).toBe(Math.floor(resetDate.getTime() / 1000) * 1000);
  });

  it("falls back to super.parseError for a 429 without any reset signal", () => {
    const executor = new OpenCodeExecutor();
    const bodyText = JSON.stringify(FREE_LIMIT_BODY);
    const parsed = executor.parseError({ status: 429 }, bodyText);
    expect(parsed.status).toBe(429);
    expect(parsed.message).toBe(bodyText);
    expect(parsed.resetsAtMs).toBeUndefined();
  });

  it("ignores a resets_at in the past and falls back", () => {
    const executor = new OpenCodeExecutor();
    const resetsAt = Math.floor(Date.now() / 1000) - 60;
    const parsed = executor.parseError({ status: 429 }, withResetFields({ resets_at: resetsAt }));
    expect(parsed.status).toBe(429);
    expect(parsed.resetsAtMs).toBeUndefined();
  });

  it("ignores reset fields on non-429 and falls back", () => {
    const executor = new OpenCodeExecutor();
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const parsed = executor.parseError({ status: 403 }, withResetFields({ resets_at: resetsAt }));
    expect(parsed.status).toBe(403);
    expect(parsed.resetsAtMs).toBeUndefined();
  });
});

describe("OpenCodeZen parseError", () => {
  it("parses resets_at unix seconds into resetsAtMs on opencode-zen", () => {
    const executor = new OpenCodeZenExecutor();
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const parsed = executor.parseError({ status: 429 }, withResetFields({ resets_at: resetsAt }));
    expect(parsed.status).toBe(429);
    expect(parsed.message).toContain("Free usage limit reached");
    expect(parsed.resetsAtMs).toBe(resetsAt * 1000);
  });

  it("parses resets_in_seconds into resetsAtMs on opencode-zen", () => {
    const executor = new OpenCodeZenExecutor();
    const before = Date.now();
    const parsed = executor.parseError({ status: 429 }, withResetFields({ resets_in_seconds: 900 }));
    const after = Date.now();
    expect(parsed.status).toBe(429);
    expect(parsed.resetsAtMs).toBeGreaterThanOrEqual(before + 900 * 1000);
    expect(parsed.resetsAtMs).toBeLessThanOrEqual(after + 900 * 1000);
  });

  it("falls back to super.parseError for a 429 without any reset signal on opencode-zen", () => {
    const executor = new OpenCodeZenExecutor();
    const bodyText = JSON.stringify(FREE_LIMIT_BODY);
    const parsed = executor.parseError({ status: 429 }, bodyText);
    expect(parsed.status).toBe(429);
    expect(parsed.message).toBe(bodyText);
    expect(parsed.resetsAtMs).toBeUndefined();
  });
});
