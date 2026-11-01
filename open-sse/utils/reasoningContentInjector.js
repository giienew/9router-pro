// Some thinking-mode providers (DeepSeek, Kimi, MiniMax, ...) require reasoning_content
// to be echoed back on assistant messages. Clients in OpenAI format don't send it,
// so we inject a non-empty placeholder to satisfy upstream validation.
//
// Strict serde upstreams (axum/DeepSeek-compatible gateways) map both `reasoning`
// and `reasoning_content` onto one struct field, so a message carrying both is
// rejected with "duplicate field `reasoning_content`" — a non-retryable 400 that
// surfaces to the client as a dead turn (observed with Hermes history, where one
// assistant message carried both keys). Never let an upstream-bound message carry
// both: keep reasoning_content, drop reasoning.
import { PROVIDERS } from "../config/providers.js";

const PLACEHOLDER = " ";

// Provider-level rules derive from registry transport.reasoningInject (single source)
const providerRuleFor = (provider) => PROVIDERS[provider]?.reasoningInject;

// Model-level rules: matched by predicate against model id
const MODEL_RULES = [
  { match: m => /^kimi-/i.test(m || ""), scope: "toolCalls" },
  { match: m => /deepseek/i.test(m || ""), scope: "all" }
];

const DEEPSEEK_V4_PRO = "deepseek-v4-pro";
const DEEPSEEK_V4_PRO_ALIASES = {
  [`${DEEPSEEK_V4_PRO}-max`]: {
    thinkingType: "enabled",
    reasoningEffort: "max"
  },
  [`${DEEPSEEK_V4_PRO}-none`]: {
    thinkingType: "disabled",
    reasoningEffort: null
  }
};

function shouldInject(message, scope) {
  if (message?.role !== "assistant") return false;
  const rc = message.reasoning_content;
  if (typeof rc === "string" && rc.length > 0) return false;
  if (scope === "toolCalls") return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  return true;
}

function applyRule(body, rule) {
  if (!rule || !body?.messages) return body;
  const messages = body.messages.map(m => {
    if (!shouldInject(m, rule.scope)) return m;
    // Injecting reasoning_content beside an existing `reasoning` key would
    // create the alias pair, so drop `reasoning` in the same pass.
    const injected = { ...m, reasoning_content: PLACEHOLDER };
    delete injected.reasoning;
    return injected;
  });
  return { ...body, messages };
}

// Drop the alias pair unconditionally (not gated on any inject rule): a
// message carrying both `reasoning` and `reasoning_content` is rejected by
// strict serde upstreams no matter which provider/model serves it.
function dropAliasedReasoning(body) {
  if (!body?.messages) return body;
  let changed = false;
  const messages = body.messages.map(m => {
    if (m && typeof m === "object" && "reasoning" in m && "reasoning_content" in m) {
      const next = { ...m };
      delete next.reasoning;
      changed = true;
      return next;
    }
    return m;
  });
  return changed ? { ...body, messages } : body;
}

function applyDeepSeekV4ProAlias({ provider, model, body }) {
  const alias = DEEPSEEK_V4_PRO_ALIASES[model];
  if (provider !== "deepseek" || !alias || !body) return body;

  const nextBody = {
    ...body,
    model: DEEPSEEK_V4_PRO,
    extra_body: {
      ...(body.extra_body || {}),
      thinking: {
        ...(body.extra_body?.thinking || {}),
        type: alias.thinkingType
      }
    }
  };

  if (alias.reasoningEffort) {
    nextBody.reasoning_effort = alias.reasoningEffort;
  } else {
    delete nextBody.reasoning_effort;
  }

  return nextBody;
}

export function injectReasoningContent({ provider, model, body }) {
  const providerRule = providerRuleFor(provider);
  const modelRule = MODEL_RULES.find(r => r.match(model));
  const rule = providerRule || modelRule;
  const nextBody = applyDeepSeekV4ProAlias({ provider, model, body });
  return applyRule(dropAliasedReasoning(nextBody), rule);
}
