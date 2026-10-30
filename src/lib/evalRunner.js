// Golden-set eval runner (R14, 9Router Pro, original code).
// NOT a side-by-side chat page and NOT Testing Studio: a saved prompt set
// with expected outputs is run through the router and scored per model.
// Scoring is deliberately dumb and auditable: PASS = the model answer
// contains the expected string (case-insensitive). Prompts without an
// expected output are reported but excluded from the pass rate.
export function scoreAnswer(content, expected) {
  if (typeof expected !== "string" || !expected.trim()) return null; // no expectation
  if (typeof content !== "string") return false;
  return content.toLowerCase().includes(expected.trim().toLowerCase());
}

export function scoreRun(results) {
  const scored = results.filter((r) => r.pass !== null);
  const passed = scored.filter((r) => r.pass === true).length;
  return {
    total: results.length,
    scored: scored.length,
    passed,
    passRate: scored.length ? passed / scored.length : null,
  };
}

// Parse the set editor's textarea: one prompt per line,
// "prompt text || expected substring" (expected optional).
export function parsePromptLines(text) {
  if (typeof text !== "string") return [];
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const idx = line.indexOf("||");
    if (idx < 0) return { prompt: line, expected: "" };
    return { prompt: line.slice(0, idx).trim(), expected: line.slice(idx + 2).trim() };
  }).filter((p) => p.prompt);
}
