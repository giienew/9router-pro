// R14 eval scoring + prompt-line parsing (pure).
import { describe, expect, it } from "vitest";
import { scoreAnswer, scoreRun, parsePromptLines } from "../../src/lib/evalRunner.js";

describe("eval scoring", () => {
  it("passes on case-insensitive substring, fails otherwise", () => {
    expect(scoreAnswer("The answer is 4.", "4")).toBe(true);
    expect(scoreAnswer("The answer is four.", "4")).toBe(false);
    expect(scoreAnswer("HELLO world", "hello")).toBe(true);
    expect(scoreAnswer("anything", "")).toBeNull(); // no expectation
    expect(scoreAnswer("anything", null)).toBeNull();
  });
  it("excludes no-expectation prompts from the pass rate", () => {
    const s = scoreRun([
      { pass: true }, { pass: false }, { pass: null },
    ]);
    expect(s).toEqual({ total: 3, scored: 2, passed: 1, passRate: 0.5 });
    expect(scoreRun([{ pass: null }]).passRate).toBeNull();
  });
  it("parses prompt || expected lines", () => {
    expect(parsePromptLines("What is 2+2? || 4\nSay hello\n\n  spaced  ||  yes  ")).toEqual([
      { prompt: "What is 2+2?", expected: "4" },
      { prompt: "Say hello", expected: "" },
      { prompt: "spaced", expected: "yes" },
    ]);
    expect(parsePromptLines("")).toEqual([]);
  });
});
