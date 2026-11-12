import { describe, expect, it } from "vitest";
import { stableJsonStringify } from "../../open-sse/utils/stableJson.js";

// A realistic chat-completions body, assembled in two different key orders.
const bodyA = {
  model: "dahl/deepseek-ai/DeepSeek-V4-Flash-0731",
  messages: [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Hi" },
  ],
  temperature: 0.7,
  stream: false,
  max_tokens: 1024,
};
const bodyB = {
  stream: false,
  max_tokens: 1024,
  temperature: 0.7,
  messages: [
    { content: "You are helpful.", role: "system" },
    { content: "Hi", role: "user" },
  ],
  model: "dahl/deepseek-ai/DeepSeek-V4-Flash-0731",
};

describe("stableJsonStringify", () => {
  it("serializes the same logical body identically regardless of key order", () => {
    expect(stableJsonStringify(bodyA)).toBe(stableJsonStringify(bodyB));
  });

  it("parses back to the same value JSON.stringify produces", () => {
    expect(JSON.parse(stableJsonStringify(bodyA))).toEqual(JSON.parse(JSON.stringify(bodyA)));
    expect(JSON.parse(stableJsonStringify(bodyB))).toEqual(JSON.parse(JSON.stringify(bodyB)));
  });

  it("mirrors JSON.stringify semantics for undefined, functions, Dates, and nesting", () => {
    const tricky = {
      b: undefined,
      a: [1, undefined, { z: 2, y: undefined }],
      c: () => 1,
      d: new Date("2026-11-12T00:00:00.000Z"),
      e: null,
      f: { h: { g: 1 }, i: [true, false] },
    };
    expect(JSON.parse(stableJsonStringify(tricky))).toEqual(JSON.parse(JSON.stringify(tricky)));
    expect(stableJsonStringify(tricky)).toContain('"a":[1,null,{"z":2}]');
    expect(stableJsonStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("throws on BigInt like JSON.stringify does", () => {
    expect(() => stableJsonStringify({ n: 1n })).toThrow(TypeError);
  });
});
