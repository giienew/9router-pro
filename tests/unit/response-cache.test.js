import { describe, it, expect } from "vitest";
import { buildCacheKey, cacheableResponse, stableStringify } from "@/lib/responseCache.js";

const body = {
  model: "openai/gpt-4o",
  messages: [{ role: "user", content: "hello" }],
  temperature: 0.7,
};

describe("response cache keys", () => {
  it("is stable regardless of key order", () => {
    expect(buildCacheKey(body)).toBe(buildCacheKey({
      temperature: 0.7,
      messages: [{ role: "user", content: "hello" }],
      model: "openai/gpt-4o",
    }));
    expect(stableStringify({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
  });

  it("changes when any parameter changes", () => {
    expect(buildCacheKey({ ...body, temperature: 0.8 })).not.toBe(buildCacheKey(body));
    expect(buildCacheKey({ ...body, messages: [{ role: "user", content: "bye" }] })).not.toBe(buildCacheKey(body));
    expect(buildCacheKey({ ...body, stream: false })).toBe(buildCacheKey(body));
  });

  it("refuses streaming, tool calls, and malformed bodies", () => {
    expect(buildCacheKey({ ...body, stream: true })).toBeNull();
    expect(buildCacheKey({ ...body, tools: [] })).toBeNull();
    expect(buildCacheKey({ ...body, tool_choice: "auto" })).toBeNull();
    expect(buildCacheKey({ messages: body.messages })).toBeNull();
    expect(buildCacheKey(null)).toBeNull();
  });

  it("only accepts successful choice responses", () => {
    expect(cacheableResponse({ choices: [{ message: {} }] })).toBe(true);
    expect(cacheableResponse({ choices: [] })).toBe(false);
    expect(cacheableResponse({ error: "boom" })).toBe(false);
    expect(cacheableResponse(null)).toBe(false);
  });
});
