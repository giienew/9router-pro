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
// Scope: finished responses — materialized JSON bodies (whatever their
// content-type header claims) and streams that close almost immediately.
// Genuinely live streams are released uninspected.

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

// Verdict for a stream that ENDED inside the probe window: scan its SSE
// payloads for any assistant content. No content at all → empty; a
// repetition loop across deltas → degenerate.
function sseEndedVerdict(text) {
  let acc = "";
  let hasTools = false;
  let hasReasoning = false;
  let sawPayload = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const json = JSON.parse(payload);
      sawPayload = true;
      const sig = extractResponseSignals(json);
      acc += sig.text;
      hasTools = hasTools || sig.hasTools;
      hasReasoning = hasReasoning || sig.hasReasoning;
      if (typeof json.delta === "string" && String(json.type || "").includes("output_text")) acc += json.delta;
    } catch { /* keep scanning */ }
  }
  if (!sawPayload) return { flaky: false };
  if (hasTools || hasReasoning) return { flaky: false };
  if (!acc.trim()) return { flaky: true, reason: "empty" };
  if (isDegenerateText(acc)) return { flaky: true, reason: "degenerate" };
  return { flaky: false };
}

const PROBE_BUDGET_MS = 120;
const PROBE_MAX_BYTES = 2_000_000;
const FULL_MAX_BYTES = 8_000_000;

function judgeFinishedText(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return { flaky: true, reason: "empty" };
  if (trimmed.startsWith("{")) {
    try { return detectFlakyResponse(JSON.parse(trimmed)); } catch {
      // Malformed JSON is itself a flaky-upstream specialty (unescaped
      // control chars, trailing junk). Salvage the content field and
      // judge that instead of giving up on the response entirely.
      const m = trimmed.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (!m) return { flaky: false, reason: "bad-json", head: trimmed.slice(0, 60), tail: trimmed.slice(-40), len: trimmed.length };
      if (/"tool_calls"|"function_call"/.test(trimmed)) return { flaky: false, reason: "salvaged-tools" };
      let content = m[1];
      try { content = JSON.parse(`"${m[1]}"`); } catch { /* judge the raw capture */ }
      if (!String(content).trim()) return { flaky: true, reason: "empty" };
      if (isDegenerateText(String(content))) return { flaky: true, reason: "degenerate" };
      return { flaky: false, reason: "salvaged-ok" };
    }
  }
  if (trimmed.startsWith("data:") || trimmed.startsWith("event:")) return sseEndedVerdict(trimmed);
  return { flaky: false, reason: "unknown-shape" };
}

// Full inspection for document-style requests (client did not ask for
// token streaming): some executors still deliver the answer as a live
// stream carrying one JSON document, so a short probe never sees the
// end of it. The clone is read to completion and judged whole; the
// original response stays intact for replay (tee semantics), and an
// over-cap body aborts the inspection fail-open.
export async function inspectChatResponseFull(response, maxBytes = FULL_MAX_BYTES) {
  try {
    if (!response?.body) return { flaky: false };
    const reader = response.clone().body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > maxBytes) {
        try { reader.cancel().catch(() => {}); } catch {}
        return { flaky: false, reason: "over-cap" };
      }
    }
    return judgeFinishedText(text);
  } catch {
    return { flaky: false, reason: "inspect-error" };
  }
}

// Inspect a fetch Response without consuming the original. The
// content-type header is NOT trusted (some executor paths label a
// materialized JSON body as text/event-stream): a clone is read with a
// short budget — bodies that finish inside the budget (materialized
// JSON, fast-closing streams) are judged; a genuinely live stream is
// released untouched when the budget runs out.
export async function inspectChatResponse(response) {
  try {
    if (!response?.body) return { flaky: false };
    const reader = response.clone().body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let ended = false;
    const deadline = Date.now() + PROBE_BUDGET_MS;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const raced = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve(null), remaining)),
      ]);
      if (raced === null) break;
      if (raced.done) { ended = true; break; }
      text += decoder.decode(raced.value, { stream: true });
      if (text.length > PROBE_MAX_BYTES) break;
    }
    if (!ended) {
      // Release the clone branch without awaiting it: on a tee'd body
      // whose source never ends, cancel() may not settle until the
      // source does — the original branch is unaffected either way.
      try { reader.cancel().catch(() => {}); } catch {}
      return { flaky: false };
    }
    return judgeFinishedText(text);
  } catch {
    return { flaky: false };
  }
}
