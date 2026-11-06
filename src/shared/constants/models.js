// Import directly from file to avoid pulling in server-side dependencies via index.js
export {
  PROVIDER_MODELS,
  getProviderModels,
  getDefaultModel,
  isValidModel as isValidModelCore,
  findModelName,
  getModelTargetFormat,
  getModelStrip,
  PROVIDER_ID_TO_ALIAS,
  getModelsByProviderId,
  getModelUpstreamId,
  getModelQuotaFamily
} from "open-sse/config/providerModels.js";

import { AI_PROVIDERS, isOpenAICompatibleProvider } from "./providers.js";
import { PROVIDER_MODELS as MODELS } from "open-sse/config/providerModels.js";

// Providers that accept any model (passthrough)
const PASSTHROUGH_PROVIDERS = new Set(
  Object.entries(AI_PROVIDERS)
    .filter(([, p]) => p.passthroughModels)
    .map(([key]) => key)
);

// Wrap isValidModel with passthrough providers
export function isValidModel(aliasOrId, modelId) {
  if (isOpenAICompatibleProvider(aliasOrId)) return true;
  if (PASSTHROUGH_PROVIDERS.has(aliasOrId)) return true;
  const models = MODELS[aliasOrId];
  if (!models) return false;
  return models.some(m => m.id === modelId);
}

// Legacy AI_MODELS for backward compatibility
export const AI_MODELS = Object.entries(MODELS).flatMap(([alias, models]) =>
  models.map(m => ({ provider: alias, model: m.id, name: m.name }))
);

export const getModelKind = (m, fallback = null) => m?.kind || m?.type || fallback;

// Capacity metadata for UI badges — icon + label + color per capability.
export const CAPACITY_META = {
  vision: { icon: "visibility", label: "Vision", desc: "Supports image input", color: "text-blue-500" },
  // search: temporarily hidden (feature not wired yet)
  reasoning: { icon: "neurology", label: "Reasoning", desc: "Supports reasoning / thinking", color: "text-amber-500" },
};

// Editable per-model capability overrides (model editor, OmniRoute-style).
// Every key maps to a DEFAULT_CAPABILITIES field; `type: "number"` rows take
// a positive integer, the rest are tri-state (Auto = use detection, On, Off).
// The editor, the API validator and the runtime reader all share this one
// list, so a new row here makes the field editable end-to-end. Kept separate
// from CAPACITY_META on purpose: the badge list above stays vision +
// reasoning only, while the editor needs the full set.
export const MODEL_CAPS_OVERRIDE_META = {
  vision: { label: "Vision", desc: "Reads image input" },
  pdf: { label: "PDF", desc: "Reads PDF / documents" },
  audioInput: { label: "Audio input", desc: "Reads audio input" },
  videoInput: { label: "Video input", desc: "Reads video input" },
  imageOutput: { label: "Image output", desc: "Generates images" },
  audioOutput: { label: "Audio output", desc: "Generates audio" },
  search: { label: "Web search", desc: "Built-in web search / grounding" },
  tools: { label: "Tool calling", desc: "Function / tool calling" },
  reasoning: { label: "Reasoning", desc: "Thinking / reasoning" },
  contextWindow: { label: "Context window", desc: "Max input tokens", type: "number" },
  maxOutput: { label: "Max output", desc: "Max output tokens", type: "number" },
};

export const MODEL_CAPS_OVERRIDE_NUMBER_KEYS = ["contextWindow", "maxOutput"];

// Largest context window any shipping model plausibly has (10M). Anything
// above is a typo, not a model — the validator drops it instead of letting a
// client budget history for a window that cannot exist.
export const MODEL_CAPS_OVERRIDE_MAX_TOKENS = 10_000_000;

// Sparse-override sanitizer: keeps only the fields the user actually set.
// Boolean keys keep true/false; number keys keep positive integers within
// bound (numeric strings from form input are accepted); null/undefined means
// "Auto" and the key is dropped, so an absent key always means "use
// detection". Unknown keys are dropped. Returns {} when the input was an
// object but nothing survived, null when the input was not an object.
export function sanitizeModelCapsOverride(caps) {
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) return null;
  const clean = {};
  for (const key of Object.keys(MODEL_CAPS_OVERRIDE_META)) {
    const value = caps[key];
    if (value === null || value === undefined) continue;
    if (MODEL_CAPS_OVERRIDE_NUMBER_KEYS.includes(key)) {
      const n = typeof value === "number" ? value : (typeof value === "string" && value.trim() !== "" ? Number(value) : NaN);
      if (Number.isInteger(n) && n > 0 && n <= MODEL_CAPS_OVERRIDE_MAX_TOKENS) clean[key] = n;
    } else if (typeof value === "boolean") {
      clean[key] = value;
    }
  }
  return clean;
}

// Realtime STT transport markers accepted on custom models — single source of
// truth across layers: the API whitelist (src/app/api/models/custom/route.js
// sanitizeTransport) and the dashboard transport select
// (providers/[id]/AddCustomModelModal) both import this map, so one new row
// here makes a realtime engine dispatch case (open-sse/handlers/sttCore.js)
// selectable and validated end-to-end. Keys must mirror a sttCore case.
export const STT_TRANSPORT_META = {
  "gemini-live": {
    label: "Gemini Live (realtime WebSocket)",
    desc: "Streams audio over bidiGenerateContent and returns incremental transcription segments",
  },
};

export const STT_TRANSPORTS = Object.freeze(Object.keys(STT_TRANSPORT_META));

export function isSttTransport(transport) {
  if (typeof transport !== "string") return false;
  return Object.prototype.hasOwnProperty.call(STT_TRANSPORT_META, transport.trim());
}
