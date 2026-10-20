// Shared system-prompt injector: inserts an instruction into the system message of
// the final request body, dispatching by format so it works for translated and
// native-passthrough flows. Used by caveman.js, ponytail.js and Prompt Injection
// (9Router Pro). position: "append" (default) or "prepend".
// injectChatTurns (bottom) is the Prompt Injection "chat" mode companion: it
// inserts scripted user/assistant turns as fake history.

import { FORMATS } from "../translator/formats.js";
import { OPENAI_BLOCK, CLAUDE_BLOCK, RESPONSES_ITEM } from "../translator/schema/blocks.js";
import { ROLE } from "../translator/schema/roles.js";

const SEP = "\n\n";

export function injectSystemPrompt(body, format, prompt, position = "append") {
  try {
    if (!body || !prompt) return;
    if (typeof body !== "object") return;
    const pos = position === "prepend" ? "prepend" : "append";

    // Kiro wire shape is unique (conversationState) — handle directly.
    if (isKiroBody(body) || format === FORMATS.KIRO) {
      injectKiroSystem(body, prompt, pos);
      return;
    }

    // Claude/Gemini own a dedicated system field, yet their bodies also carry
    // messages[]/contents[] — decide by format label before the shape sniff below.
    // Anthropic rejects a "system" role inside messages[] (no such input role).
    if (format === FORMATS.CLAUDE) {
      injectClaudeSystem(body, prompt, pos);
      return;
    }
    if (format === FORMATS.GEMINI || format === FORMATS.GEMINI_CLI
      || format === FORMATS.VERTEX || format === FORMATS.ANTIGRAVITY) {
      // Antigravity wraps Gemini shape in body.request → injectGeminiSystem handles it
      injectGeminiSystem(body, prompt, pos);
      return;
    }

    // Dispatch by actual wire shape for OpenAI-shaped formats.
    // instructions string takes precedence; messages[] means Chat; input[] means Responses.
    if (typeof body.instructions === "string") {
      injectInstructionsSystem(body, prompt, pos);
      return;
    }
    if (Array.isArray(body.messages)) {
      injectChatSystem(body, prompt, pos);
      return;
    }
    if (Array.isArray(body.input)) {
      // Responses input[]: empty array already normalized elsewhere; string stays untouched here
      injectResponsesInputSystem(body, prompt, pos);
      return;
    }
    if (typeof body.input === "string") {
      // string input must stay untouched
      return;
    }

    // OpenAI-shaped but no array (e.g. empty body) — no-op
  } catch (_) {
    // fail-open
  }
}

function isKiroBody(body) {
  if (!body || typeof body !== "object") return false;
  const cs = body.conversationState;
  if (!cs || typeof cs !== "object") return false;
  // A top-level `systemPrompt` used to be the marker, but the Kiro translator no
  // longer emits it (kiro.dev rejects the field), so gate on the turn shape.
  const historyTurn = Array.isArray(cs.history)
    && cs.history.some(it => it && (it.userInputMessage || it.assistantResponseMessage));
  return historyTurn || !!(cs.currentMessage && cs.currentMessage.userInputMessage);
}

// Exact idempotency: prompt present as its own SEP-delimited segment (or the
// whole string), not as a substring of unrelated text.
function hasPrompt(haystack, prompt) {
  if (!haystack || typeof haystack !== "string") return false;
  if (haystack === prompt) return true;
  return haystack.split(SEP).includes(prompt);
}

function dedupStringAppend(curr, prompt, position = "append") {
  if (!curr) return prompt;
  if (hasPrompt(curr, prompt)) return curr;
  return position === "prepend" ? `${prompt}${SEP}${curr}` : `${curr}${SEP}${prompt}`;
}

// ---- OpenAI instructions string ----
function injectInstructionsSystem(body, prompt, position = "append") {
  try {
    const curr = body.instructions;
    if (typeof curr !== "string") return;
    if (hasPrompt(curr, prompt)) return;
    const next = curr ? dedupStringAppend(curr, prompt, position) : prompt;
    try { body.instructions = next; } catch (_) { /* frozen/proxy fail-open */ }
  } catch (_) {}
}

// ---- Chat messages[] ----
function injectChatSystem(body, prompt, position = "append") {
  try {
    const arr = body.messages;
    if (!Array.isArray(arr)) return;
    // Exact idempotency: scan existing system/developer content for full prompt
    if (containsPromptInMessages(arr, prompt)) return;
    let idx = -1;
    try { idx = arr.findIndex(m => m && (m.role === ROLE.SYSTEM || m.role === ROLE.DEVELOPER)); } catch (_) { return; }
    if (idx >= 0) {
      appendToChatMessage(arr[idx], prompt, position);
    } else {
      // create typed system message at index 0; fail-open on frozen/proxy
      try { arr.unshift({ role: ROLE.SYSTEM, content: prompt }); } catch (_) {}
    }
  } catch (_) {}
}

function containsPromptInMessages(arr, prompt) {
  try {
    for (const m of arr) {
      if (!m || (m.role !== ROLE.SYSTEM && m.role !== ROLE.DEVELOPER)) continue;
      const c = m.content;
      if (typeof c === "string" && hasPrompt(c, prompt)) return true;
      if (Array.isArray(c)) {
        for (const part of c) {
          if (part && typeof part.text === "string" && hasPrompt(part.text, prompt)) return true;
        }
      }
    }
  } catch (_) {}
  return false;
}

function appendToChatMessage(msg, prompt, position = "append") {
  try {
    if (!msg || typeof msg !== "object") return;
    const c = msg.content;
    if (typeof c === "string") {
      const next = dedupStringAppend(c, prompt, position);
      if (next === c) return;
      // avoid partial mutation: try assignment, bail if setter throws
      try { msg.content = next; } catch (_) {}
      return;
    }
    if (Array.isArray(c)) {
      // already deduped at message level; but guard block-level too
      try {
        if (c.some(b => b && b.text === prompt)) return;
      } catch (_) {}
      try {
        if (position === "prepend") c.unshift({ type: OPENAI_BLOCK.TEXT, text: prompt });
        else c.push({ type: OPENAI_BLOCK.TEXT, text: prompt });
      } catch (_) {}
      return;
    }
    try { msg.content = prompt; } catch (_) {}
  } catch (_) {}
}

// ---- Responses input[] ----
function injectResponsesInputSystem(body, prompt, position = "append") {
  try {
    const arr = body.input;
    if (!Array.isArray(arr)) return;
    // instructions already handled above
    if (containsPromptInResponsesInput(arr, prompt)) return;
    // find system/developer message items only (type === message)
    let idx = -1;
    try {
      idx = arr.findIndex(m => m && m.type === RESPONSES_ITEM.MESSAGE && (m.role === ROLE.SYSTEM || m.role === ROLE.DEVELOPER));
    } catch (_) { return; }
    if (idx >= 0) {
      appendToResponsesMessage(arr[idx], prompt, position);
    } else {
      const msg = { type: RESPONSES_ITEM.MESSAGE, role: ROLE.SYSTEM, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: prompt }] };
      try { arr.unshift(msg); } catch (_) {}
    }
  } catch (_) {}
}

function containsPromptInResponsesInput(arr, prompt) {
  try {
    for (const item of arr) {
      if (!item || item.type !== RESPONSES_ITEM.MESSAGE) continue;
      if (item.role !== ROLE.SYSTEM && item.role !== ROLE.DEVELOPER) continue;
      const c = item.content;
      if (typeof c === "string" && hasPrompt(c, prompt)) return true;
      if (Array.isArray(c)) {
        for (const part of c) {
          if (part && typeof part.text === "string" && hasPrompt(part.text, prompt)) return true;
        }
      }
    }
  } catch (_) {}
  return false;
}

function appendToResponsesMessage(msg, prompt, position = "append") {
  try {
    if (!msg || typeof msg !== "object") return;
    const c = msg.content;
    if (typeof c === "string") {
      const next = dedupStringAppend(c, prompt, position);
      if (next === c) return;
      try { msg.content = next; } catch (_) {}
      return;
    }
    if (Array.isArray(c)) {
      try { if (c.some(b => b && b.text === prompt)) return; } catch (_) {}
      try {
        if (position === "prepend") c.unshift({ type: RESPONSES_ITEM.INPUT_TEXT, text: prompt });
        else c.push({ type: RESPONSES_ITEM.INPUT_TEXT, text: prompt });
      } catch (_) {}
      return;
    }
    try { msg.content = [{ type: RESPONSES_ITEM.INPUT_TEXT, text: prompt }]; } catch (_) {}
  } catch (_) {}
}

// ---- Claude ----
function injectClaudeSystem(body, prompt, position = "append") {
  try {
    const sys = body.system;
    if (typeof sys === "string") {
      if (hasPrompt(sys, prompt)) return;
      const next = sys.length > 0 ? dedupStringAppend(sys, prompt, position) : prompt;
      try { body.system = next; } catch (_) {}
      return;
    }
    if (Array.isArray(sys)) {
      try { if (sys.some(b => b && b.text === prompt)) return; } catch (_) {}
      const block = { type: CLAUDE_BLOCK.TEXT, text: prompt };
      if (position === "prepend") {
        // Front of the system array; any cache_control marker further down
        // still caches the (now longer, but stable) prefix that follows it.
        try { sys.unshift(block); } catch (_) {}
        return;
      }
      let lastCacheIdx = -1;
      try {
        for (let i = sys.length - 1; i >= 0; i--) {
          if (sys[i]?.cache_control) { lastCacheIdx = i; break; }
        }
      } catch (_) {}
      try {
        if (lastCacheIdx >= 0) sys.splice(lastCacheIdx, 0, block);
        else sys.push(block);
      } catch (_) {}
      return;
    }
    // absent/null
    try { body.system = prompt; } catch (_) {}
  } catch (_) {}
}

// ---- Gemini ----
function injectGeminiSystem(body, prompt, position = "append") {
  try {
    let target = body;
    try {
      if (body.request && typeof body.request === "object") target = body.request;
    } catch (_) {}
    let useSnake = false;
    try { useSnake = Object.prototype.hasOwnProperty.call(target, "system_instruction"); } catch (_) {}
    const key = useSnake ? "system_instruction" : "systemInstruction";
    let sys;
    try { sys = target[key]; } catch (_) { sys = undefined; }
    if (sys && Array.isArray(sys.parts)) {
      try { if (sys.parts.some(p => p && p.text === prompt)) return; } catch (_) {}
      try {
        if (position === "prepend") sys.parts.unshift({ text: prompt });
        else sys.parts.push({ text: prompt });
      } catch (_) {}
      return;
    }
    try { target[key] = { parts: [{ text: prompt }] }; } catch (_) {}
  } catch (_) {}
}

// ---- Kiro ----
// The prompt is appended to the first user turn's content — the same place the
// Kiro translator already mirrors the system text via its contentPrefix.
//
// A top-level `systemPrompt` is deliberately NOT written: the kiro.dev gateway
// answers any body carrying that field with
//   400 {"message":"Improperly formed request.","reason":"REQUEST_BODY_INVALID"}
// The translator stopped emitting it in v0.5.59, but this injector kept adding
// it back, so every kr/ model failed whenever an RTK prompt (caveman, ponytail)
// was active.
function injectKiroSystem(body, prompt, position = "append") {
  try {
    const cs = body.conversationState;
    let targetMsg = null;
    const hist = Array.isArray(cs?.history) ? cs.history : null;
    if (hist) {
      for (const item of hist) {
        if (item && item.userInputMessage) { targetMsg = item.userInputMessage; break; }
      }
    }
    if (!targetMsg && cs?.currentMessage?.userInputMessage) {
      targetMsg = cs.currentMessage.userInputMessage;
    }
    if (!targetMsg) return;

    const content = typeof targetMsg.content === "string" ? targetMsg.content : "";
    const next = dedupStringAppend(content, prompt, position);
    if (next === content) return; // already injected — idempotent across retries
    try { targetMsg.content = next; } catch (_) { /* frozen/proxy fail-open */ }
  } catch (_) {}
}

// ---- Chat turns (Prompt Injection "chat" mode) ----
// Inserts scripted turns as fake history right after any leading system
// message(s), so the model reads them as a conversation that already
// happened. If the turn block would end with the same role the real
// conversation starts with, the two string contents are merged (providers
// like Anthropic reject consecutive same-role messages). Idempotent: an
// identical block already at the insertion point is left alone. Fail-open.

export function injectChatTurns(body, format, turns) {
  try {
    if (!body || typeof body !== "object") return;
    const clean = (Array.isArray(turns) ? turns : []).filter(
      t => t && (t.role === ROLE.USER || t.role === ROLE.ASSISTANT)
        && typeof t.content === "string" && t.content.trim()
    );
    if (!clean.length) return;
    if (isKiroBody(body) || format === FORMATS.KIRO) return; // no safe history shape

    if (format === FORMATS.GEMINI || format === FORMATS.GEMINI_CLI
      || format === FORMATS.VERTEX || format === FORMATS.ANTIGRAVITY) {
      let target = body;
      try {
        if (body.request && typeof body.request === "object" && Array.isArray(body.request.contents)) {
          target = body.request;
        }
      } catch (_) {}
      if (Array.isArray(target.contents)) { insertTurnsIntoContents(target.contents, clean); return; }
    }
    if (Array.isArray(body.messages)) { insertTurnsIntoMessages(body.messages, clean); return; }
    if (Array.isArray(body.input)) { insertTurnsIntoResponsesInput(body.input, clean); return; }
    // instructions-only / string input — nowhere safe to put turns
  } catch (_) { /* fail-open */ }
}

function insertTurnsIntoMessages(arr, turns) {
  let idx = 0;
  while (idx < arr.length && arr[idx] && (arr[idx].role === ROLE.SYSTEM || arr[idx].role === ROLE.DEVELOPER)) idx++;
  // Idempotency: identical block already sitting at the insertion point
  let already = turns.length <= arr.length - idx;
  for (let i = 0; already && i < turns.length; i++) {
    const m = arr[idx + i];
    if (!m || m.role !== turns[i].role || m.content !== turns[i].content) already = false;
  }
  if (already) return;
  const block = turns.map(t => ({ role: t.role, content: t.content }));
  const next = arr[idx];
  const last = block[block.length - 1];
  if (next && next.role === last.role && typeof next.content === "string") {
    // Same role as the real conversation's first message — merge into one
    last.content = `${last.content}${SEP}${next.content}`;
    arr.splice(idx, 1);
  }
  arr.splice(idx, 0, ...block);
}

function insertTurnsIntoContents(contents, turns) {
  const block = turns.map(t => ({
    role: t.role === ROLE.ASSISTANT ? "model" : ROLE.USER,
    parts: [{ text: t.content }],
  }));
  let already = block.length <= contents.length;
  for (let i = 0; already && i < block.length; i++) {
    const c = contents[i];
    if (!c || c.role !== block[i].role || !Array.isArray(c.parts)
      || c.parts.length !== 1 || c.parts[0]?.text !== block[i].parts[0].text) already = false;
  }
  if (already) return;
  const next = contents[0];
  const last = block[block.length - 1];
  if (next && next.role === last.role && Array.isArray(next.parts)
    && next.parts.length === 1 && typeof next.parts[0]?.text === "string") {
    last.parts = [{ text: `${last.parts[0].text}${SEP}${next.parts[0].text}` }];
    contents.splice(0, 1);
  }
  contents.splice(0, 0, ...block);
}

function insertTurnsIntoResponsesInput(input, turns) {
  let idx = 0;
  while (idx < input.length && input[idx] && input[idx].type === RESPONSES_ITEM.MESSAGE
    && (input[idx].role === ROLE.SYSTEM || input[idx].role === ROLE.DEVELOPER)) idx++;
  const block = turns.map(t => ({
    type: RESPONSES_ITEM.MESSAGE,
    role: t.role,
    content: [{ type: t.role === ROLE.ASSISTANT ? RESPONSES_ITEM.OUTPUT_TEXT : RESPONSES_ITEM.INPUT_TEXT, text: t.content }],
  }));
  const next = input[idx];
  const last = block[block.length - 1];
  if (next && next.type === RESPONSES_ITEM.MESSAGE && next.role === last.role
    && Array.isArray(next.content) && next.content.length === 1
    && typeof next.content[0]?.text === "string") {
    last.content = [{ type: last.content[0].type, text: `${last.content[0].text}${SEP}${next.content[0].text}` }];
    input.splice(idx, 1);
  }
  input.splice(idx, 0, ...block);
}
