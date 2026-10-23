// Console Log panel parser (9Router Pro): raw console lines become
// MatLog-style rows — time, level badge, short tag, session dot, message.
// Cases are the real line shapes the logger emits.
import { describe, expect, it } from "vitest";
import { parseConsoleLine } from "../../src/lib/logLineParse.js";

describe("parseConsoleLine", () => {
  it("parses a tag-logger info line", () => {
    const p = parseConsoleLine("[23:13:15] ℹ️  [PROXY] dahl/zai-org/GLM-5.3-Flash · Key 55 · proxy 209.50.169.103:3129");
    expect(p.time).toBe("23:13:15");
    expect(p.level).toBe("I");
    expect(p.tag).toBe("PROXY");
    expect(p.dot).toBe("");
    expect(p.message).toBe("dahl/zai-org/GLM-5.3-Flash · Key 55 · proxy 209.50.169.103:3129");
  });

  it("parses a request line with session dot", () => {
    const p = parseConsoleLine("[23:13:18] 🟢 ▶ POST glm_un → dahl/zai-org/GLM-5.3-Flash · stream · 671 messages · key Key 45");
    expect(p.level).toBe("I");
    expect(p.tag).toBe("REQ");
    expect(p.dot).toBe("#22c55e");
    expect(p.message.startsWith("POST glm_un")).toBe(true);
  });

  it("parses an error line as level E", () => {
    const p = parseConsoleLine("[23:13:18] 🔴 ✗ ERROR 402 · dahl/zai-org/GLM-5.3-Flash · quota exhausted · 2.6s — available tokens exhausted");
    expect(p.level).toBe("E");
    expect(p.tag).toBe("ERR");
    expect(p.dot).toBe("#ef4444");
    expect(p.message.startsWith("ERROR 402")).toBe(true);
  });

  it("parses a done line as the success badge", () => {
    const p = parseConsoleLine("[23:10:29] ⚪ 📊 done · 18.4s · in 112,790 · out 752");
    expect(p.level).toBe("✓");
    expect(p.tag).toBe("DONE");
    expect(p.dot).toBe("#e5e7eb");
  });

  it("parses a warn tag line", () => {
    const p = parseConsoleLine("[23:13:18] ⚠️  [AUTH] Key 55 · 402 quota exhausted · zai-org/GLM-5.3-Flash locked 2m 00s");
    expect(p.level).toBe("W");
    expect(p.tag).toBe("AUTH");
    expect(p.message.startsWith("Key 55")).toBe(true);
  });

  it("parses the plain console.error provider line", () => {
    const p = parseConsoleLine("❌ dahl [402]: quota exhausted");
    expect(p.level).toBe("E");
    expect(p.tag).toBe("DAHL");
    expect(p.message).toBe("402 · quota exhausted");
  });

  it("parses the transform line", () => {
    const p = parseConsoleLine("[23:13:15] 🟤 ⚙ prompt injected: glm_un");
    expect(p.level).toBe("I");
    expect(p.tag).toBe("PRO");
    expect(p.dot).toBe("#b45309");
    expect(p.message).toBe("prompt injected: glm_un");
  });

  it("keeps the bracket tag when a symbol is also present", () => {
    const p = parseConsoleLine("[23:02:28] 🟠 📊 [USAGE] dahl · in 1,234 · out 56");
    expect(p.tag).toBe("USAGE");
    expect(p.level).toBe("✓");
  });

  it("degrades unstructured lines to a neutral row with the raw text", () => {
    const p = parseConsoleLine("✓ Ready in 123ms");
    expect(p.level).toBe("·");
    expect(p.tag).toBe("");
    expect(p.message).toBe("✓ Ready in 123ms");
  });
});
