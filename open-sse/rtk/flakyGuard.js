// Anti-Flaky Guard (9Router Pro) — pure response-quality checks.
//
// Some upstreams (notably large shared key pools) intermittently answer
// HTTP 200 with an empty body text or a degenerate repetition loop
// ("OK.OK.OK.OK..."). The router used to pass those straight through, so
// clients received garbage with a success status. These helpers classify
// a finished JSON chat response so the caller can retry with another
// account instead. Fail-open by design: anything unrecognized, malformed
// or merely unusual is treated as a good response.
//
// Scope: non-streaming JSON responses (including forced-SSE→JSON).
// Streamed responses pass through uninspected.

export const ANTI_FLAKY_DEFAULTS = { enabled: true, maxRetries: 2 };
const MAX_RETRIES_CAP = 5;
const DEGENERATE_MIN_LENGTH = 24;
const DEGENERATE_COVERAGE = 0.8;
const DEGENERATE_MIN_REPEATS = 4;
const WORD_RUN_MIN = 8;

// Settings live in the free-form settings blob (antiFlakyEnabled /
// antiFlakyMaxRetries), merged like the other request-path toggles.
export function resolveAntiFlakyConfig(settings) {
  const s = settings || {};
  const enabled = s.antiFlakyEnabled !== false;
  let maxRetries = Number.isFinite(s.antiFlakyMaxRetries) ? Math.floor(s.antiFlakyMaxRetries) : ANTI_FLAKY_DEFAULTS.maxRetries;
  if (maxRetries < 0) maxRetries = 0;
  if (maxRetries > MAX_RETRIES_CAP) maxRetries = MAX_RETRIES_CAP;
  return { enabled, maxRetries };
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let out = "";
    for (const part of content) {
      if (typeof part === "string") out += part;
      else if (part && typeof part.text === "string") out += part.text;
    }
    return out;
  }
  return "";
}

// Extract { text, hasTools, hasReasoning } from any supported wire shape:
// OpenAI chat completions, Claude messages, OpenAI Responses, Gemini.
export function extractResponseSignals(json) {
  const none = { text: "", hasTools: false, hasReasoning: false };
  if (!json || typeof json !== "object") return none;

  const choice = Array.isArray(json.choices) ? json.choices[0] : null;
  if (choice && (choice.message || choice.delta)) {
    const msg = choice.message || choice.delta || {};
    return {
      text: textFromContent(msg.content),
      hasTools: Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0,
      hasReasoning: typeof msg.reasoning_content === "string" && msg.reasoning_content.trim().length > 0,
    };
  }

  if (json.type === "message" && Array.isArray(json.content)) {
    let text = "";
    let hasTools = false;
    for (const block of json.content) {
      if (!block) continue;
      if (block.type === "text") text += block.text || "";
      else if (block.type === "tool_use") hasTools = true;
      else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) none.hasReasoning = true;
    }
    return { text, hasTools, hasReasoning: none.hasReasoning };
  }

  if (Array.isArray(json.output)) {
    let text = "";
    let hasTools = false;
    let hasReasoning = false;
    for (const item of json.output) {
      if (!item) continue;
      if (item.type === "function_call" || item.type === "custom_tool_call") hasTools = true;
      else if (item.type === "reasoning") hasReasoning = true;
      else if (Array.isArray(item.content)) text += textFromContent(item.content);
    }
    return { text, hasTools, hasReasoning };
  }

  const candidate = Array.isArray(json.candidates) ? json.candidates[0] : null;
  if (candidate?.content?.parts) {
    let text = "";
    let hasTools = false;
    for (const part of candidate.content.parts) {
      if (!part) continue;
      if (typeof part.text === "string" && part.thought !== true) text += part.text;
      if (part.functionCall || part.function_call) hasTools = true;
      if (part.inlineData || part.inline_data) text += " "; // media counts as content
    }
    return { text, hasTools, hasReasoning: false };
  }

  return none;
}

// A text is degenerate when one short unit (or one word) repeats until it
// dominates the whole answer — the classic pool-upstream loop failure.
export function isDegenerateText(text) {
  const t = typeof text === "string" ? text.trim() : "";
  if (t.length < DEGENERATE_MIN_LENGTH) return false;

  for (let u = 1; u <= 16; u++) {
    const unit = t.slice(0, u);
    if (!unit.trim()) continue;
    let covered = 0;
    while (covered + u <= t.length && t.startsWith(unit, covered)) covered += u;
    const rest = t.slice(covered);
    const tailOk = rest.length > 0 && rest.length < u && unit.startsWith(rest);
    if ((covered === t.length || tailOk) && covered >= t.length * DEGENERATE_COVERAGE && covered / u >= DEGENERATE_MIN_REPEATS) return true;
  }

  const words = t.split(/\s+/);
  if (words.length >= 12) {
    let run = 1;
    let maxRun = 1;
    for (let i = 1; i < words.length; i++) {
      run = words[i] === words[i - 1] ? run + 1 : 1;
      if (run > maxRun) maxRun = run;
    }
    if (maxRun >= WORD_RUN_MIN && maxRun / words.length >= 0.5) return true;
  }

  return false;
}

// Classify a finished JSON response body. Returns { flaky, reason } —
// reason is "empty" or "degenerate". Tool calls and reasoning-only
// answers are legitimate and never flagged.
export function detectFlakyResponse(json) {
  try {
    // Unparseable / non-object bodies cannot be judged — fail open.
    if (!json || typeof json !== "object" || Array.isArray(json)) return { flaky: false };
    const { text, hasTools, hasReasoning } = extractResponseSignals(json);
    if (hasTools || hasReasoning) return { flaky: false };
    if (!text || !text.trim()) return { flaky: true, reason: "empty" };
    if (isDegenerateText(text)) return { flaky: true, reason: "degenerate" };
    return { flaky: false };
  } catch {
    return { flaky: false };
  }
}

// Inspect a fetch Response without consuming the original: only JSON
// bodies are read (via clone); anything else is left alone.
export async function inspectJsonResponse(response) {
  try {
    const contentType = response?.headers?.get?.("content-type") || "";
    if (!contentType.includes("application/json")) return { flaky: false };
    const json = await response.clone().json();
    return detectFlakyResponse(json);
  } catch {
    return { flaky: false };
  }
}
