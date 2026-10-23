import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { isMuseSparkModel } from "../providers/models/helpers.js";
import { applyFingerprintTools } from "../utils/opencodeFingerprint.js";
import { ANTHROPIC_API_VERSION } from "../providers/shared.js";
import {
  normalizeResponsesInput,
  clampResponsesCallId,
  coerceResponsesArguments,
  coerceResponsesOutput,
} from "../translator/formats/responsesApi.js";

/**
 * OpenCode Free V2 Executor
 * Fully reverse-engineered from official OpenCode CLI 1.19.4 (Bun/AI-SDK runtime).
 */
const OPENCODE_V2_UA = "opencode/1.19.4 ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4";
const OPENCODE_V2_CLIENT = "cli";
const MAX_SESSION_LENGTH = 256;
const MAX_TOOL_NAME_LEN = 128;
const SESSION_HEADER = "x-opencode-session";
const SESSION_FIELD = "_opencodeV2Session";
export const OPENCODE_V2_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function hasValidOpencodeVersion(ua) {
  return /^opencode\/\d+\.\d+\.\d+ ai-sdk\/provider-utils\/[\d.]+ runtime\/bun\/[\d.]+$/i.test(String(ua || ""));
}

const RESPONSES_MODELS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);
const MESSAGES_MODELS = new Set(["union-alpha"]);

let lastTimestamp = 0;
let counter = 0;

function unstableRandom() {
  const bytes = crypto.randomBytes(14);
  let randomPart = "";
  for (let i = 0; i < 14; i++) {
    randomPart += BASE62_CHARS[bytes[i] % 62];
  }
  return randomPart;
}

/**
 * Bitwise timestamp generator verbatim from decompiled OpenCode 1.19.4 CLI:
 * - isSession = true  -> bitwise NOT (~n) produces 'ses_...' (descending timestamp hex)
 * - isSession = false -> direct (n) produces 'msg_...' (ascending timestamp hex)
 */
function generateBitwiseId(isSession = true, timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;

  const combined = BigInt(timestamp) * 0x1000n + BigInt(counter);
  const bitwiseVal = isSession ? ~combined : combined;

  const hexParts = [];
  for (let idx = 0; idx < 6; idx++) {
    const shiftBits = BigInt(40 - 8 * idx);
    const byteVal = Number((bitwiseVal >> shiftBits) & 0xffn);
    hexParts.push(byteVal.toString(16).padStart(2, "0"));
  }

  return hexParts.join("") + unstableRandom();
}

export function generateV2SessionId() {
  return `ses_${generateBitwiseId(true)}`;
}

export function generateV2RequestId() {
  return `msg_${generateBitwiseId(false)}`;
}

function normalizeSession(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (OPENCODE_V2_SESSION_RE.test(trimmed)) return trimmed;
  return null;
}

function nativeSession(headers) {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) {
      const match = normalizeSession(value);
      if (match) return match;
    }
  }
  return null;
}

function translateSessionId(rawId, clientTool) {
  if (!rawId) return generateV2SessionId();
  const trimmed = String(rawId).trim();
  if (OPENCODE_V2_SESSION_RE.test(trimmed)) return trimmed;

  const tool = String(clientTool || "").toLowerCase();
  const hex = crypto.createHash("sha256").update(`${tool}:${trimmed}`).digest("hex");
  return `ses_${hex.slice(0, 12)}${unstableRandom()}`;
}

// One stable canonical session per downstream identity, like the real CLI:
// minting a fresh session on every request burns the free quota faster, so
// the stable one is kept until it expires by TTL.
const stableOpencodeV2Sessions = new Map();
const MAX_STABLE_SESSIONS = 1000;
const stableSessionCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of stableOpencodeV2Sessions) {
    if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) {
      stableOpencodeV2Sessions.delete(key);
    }
  }
}, MEMORY_CONFIG.sessionCleanupIntervalMs);
if (stableSessionCleanup.unref) stableSessionCleanup.unref();

function identityKey(credentials) {
  const connectionId = credentials?.connectionId || credentials?.id;
  if (connectionId) return `opencode-v2:conn:${String(connectionId).slice(0, 128)}`;
  const raw = credentials?.rawHeaders || {};
  const auth = raw.authorization || raw.Authorization || raw["x-api-key"] || raw["X-Api-Key"] || "";
  if (auth) {
    const digest = crypto.createHash("sha256").update(String(auth)).digest("hex").slice(0, 32);
    return `opencode-v2:auth:${digest}`;
  }
  return "opencode-v2:default";
}

export function stableV2SessionId(credentials) {
  const key = identityKey(credentials);
  const existing = stableOpencodeV2Sessions.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    stableOpencodeV2Sessions.delete(key);
    stableOpencodeV2Sessions.set(key, existing);
    return existing.sessionId;
  }
  const sessionId = generateV2SessionId();
  if (stableOpencodeV2Sessions.size >= MAX_STABLE_SESSIONS) {
    stableOpencodeV2Sessions.delete(stableOpencodeV2Sessions.keys().next().value);
  }
  stableOpencodeV2Sessions.set(key, { sessionId, lastUsed: Date.now() });
  return sessionId;
}

function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

function isResponsesModel(model) {
  const base = baseModelId(model);
  return RESPONSES_MODELS.has(base) || isMuseSparkModel(base);
}

function isMessagesModel(model) {
  return MESSAGES_MODELS.has(baseModelId(model));
}

function resolveOpencodeV2Session(body, credentials, providerSessionId, clientTool) {
  const headers = credentials?.rawHeaders || {};
  const native = nativeSession(headers);
  if (native) return native;

  let incoming = null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) {
      incoming = normalizeSession(value);
      break;
    }
  }

  const hinted = incoming || normalizeSession(providerSessionId);
  if (hinted) return translateSessionId(hinted, clientTool);

  if (credentials?.connectionId) {
    let viaManager = null;
    try {
      viaManager = resolveSessionId({
        headers,
        body,
        connectionId: credentials?.connectionId,
        scope: "opencode-v2",
      });
    } catch {
      viaManager = null;
    }
    if (viaManager) return translateSessionId(viaManager, clientTool);
  }

  return stableV2SessionId(credentials);
}

function normalizeResponsesTools(body) {
  if (!Array.isArray(body.tools)) return;
  const validNames = new Set();
  const clamped = [];
  for (const tool of body.tools) {
    if (tool && typeof tool === "object" && typeof tool.name === "string" && tool.name.trim() !== "") {
      const trimmed = tool.name.trim().slice(0, MAX_TOOL_NAME_LEN);
      if (validNames.has(trimmed)) continue;
      validNames.add(trimmed);
      clamped.push({ ...tool, name: trimmed });
    }
  }
  body.tools = clamped;
}

function sanitizeResponsesItems(body) {
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item) => {
    if (!item || typeof item !== "object") return false;
    if (item.type === "reasoning") return false;
    delete item.encrypted_content;
    delete item.reasoning_encrypted_content;
    if (item.type === "function_call") {
      if (!item.name || typeof item.name !== "string" || item.name.trim() === "") return false;
      item.name = item.name.trim().slice(0, MAX_TOOL_NAME_LEN);
      item.call_id = clampResponsesCallId(item.call_id);
      item.arguments = coerceResponsesArguments(item.arguments);
      return true;
    }
    if (item.type === "function_call_output") {
      item.call_id = clampResponsesCallId(item.call_id);
      item.output = coerceResponsesOutput(item.output);
      return true;
    }
    return true;
  });
}

function normalizeOpencodeReasoning(model, body) {
  const current = body.reasoning;
  const currentReasoning = current && typeof current === "object" && !Array.isArray(current)
    ? current
    : null;
  const requestedEffort = typeof body.reasoning_effort === "string"
    ? body.reasoning_effort
    : currentReasoning?.effort;
  if (typeof requestedEffort !== "string") return;

  const cleanModel = baseModelId(model || body.model);
  const supportedLevels = getThinkingLevels("opencode-v2", cleanModel);
  let effort = requestedEffort.toLowerCase().trim();
  if ((effort === "max" || effort === "ultra") && supportedLevels?.length && !supportedLevels.includes(effort)) {
    if (effort === "ultra" && supportedLevels.includes("max")) effort = "max";
    else if (supportedLevels.includes("xhigh")) effort = "xhigh";
  }

  body.reasoning = { ...currentReasoning, effort };
  if (!body.reasoning.summary) body.reasoning.summary = "auto";
  delete body.reasoning_effort;
}

export class OpenCodeV2Executor extends BaseExecutor {
  constructor() {
    super("opencode-v2", PROVIDERS["opencode-v2"] || PROVIDERS.opencode);
  }

  prepareRequestCredentials({ body, credentials, providerSessionId, clientTool } = {}) {
    const sourceCredentials = credentials || {};
    const session = resolveOpencodeV2Session(body, sourceCredentials, providerSessionId, clientTool);

    return {
      ...sourceCredentials,
      [SESSION_FIELD]: session,
    };
  }

  transformRequest(model, body, stream, credentials) {
    if (body && typeof body === "object" && model && !body.model) body.model = model;
    if (body && typeof body === "object") {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }

    if (isResponsesModel(model || body?.model) && body && typeof body === "object") {
      if ("tool_choice" in body && body.tool_choice !== "auto"
        && this.config.quirks?.forceAutoToolChoiceModels?.includes(baseModelId(model))) {
        body.tool_choice = "auto";
      }
      const normalized = normalizeResponsesInput(body.input);
      if (normalized) body.input = normalized;
      if (!Array.isArray(body.input) || body.input.length === 0) {
        body.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
      }
      if (body.max_output_tokens === undefined) {
        if (body.max_completion_tokens !== undefined) body.max_output_tokens = body.max_completion_tokens;
        else if (body.max_tokens !== undefined) body.max_output_tokens = body.max_tokens;
      }
      delete body.max_tokens;
      delete body.max_completion_tokens;
      normalizeOpencodeReasoning(model, body);
      body.stream = true;
      body.store = false;
      normalizeResponsesTools(body);
      sanitizeResponsesItems(body);
      applyFingerprintTools(body, true);
    } else if (body && typeof body === "object") {
      applyFingerprintTools(body, false);
    }

    return injectReasoningContent({ provider: this.provider, model, body });
  }

  async execute(args) {
    return super.execute({ ...args, credentials: this.prepareRequestCredentials(args) });
  }

  buildUrl(model) {
    const base = this.config.baseUrl || "https://opencode.ai";
    if (isResponsesModel(model)) return `${base}/inference/v1/responses`;
    if (isMessagesModel(model)) return `${base}/inference/anthropic/v1/messages`;
    return `${base}/inference/openai/v1/chat/completions`;
  }

  buildHeaders(credentials, stream = true, url = "") {
    const raw = credentials?.rawHeaders || {};
    const lower = {};
    for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;

    const downstreamUa = lower["user-agent"] || "";
    const isOpencodeDownstream = hasValidOpencodeVersion(downstreamUa);

    const session = credentials?.[SESSION_FIELD] || this.prepareRequestCredentials({ credentials })[SESSION_FIELD];

    const headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer public",
      "User-Agent": isOpencodeDownstream ? downstreamUa : OPENCODE_V2_UA,
      "x-opencode-client": lower["x-opencode-client"] || OPENCODE_V2_CLIENT,
      "x-opencode-session": session,
      "x-opencode-session-id": session,
      "x-opencode-request": generateV2RequestId(),
      "x-opencode-project": lower["x-opencode-project"] || "global",
      "Accept": stream ? "text/event-stream" : "*/*",
    };
    if (url.endsWith("/messages")) headers["anthropic-version"] = ANTHROPIC_API_VERSION;
    return headers;
  }
}
