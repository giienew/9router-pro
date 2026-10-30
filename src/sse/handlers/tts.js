import {
  extractApiKey, isValidApiKey,
  getProviderCredentials, markAccountUnavailable,
} from "../services/auth.js";
import { resolveComboMemberAttemptCap, createAttemptLimiter, accountExhaustedResponse } from "../services/memberFailover.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { getKeyAccessContext, enforceKeyAccess } from "../services/keyAccess.js";
import { handleTtsCore } from "open-sse/handlers/ttsCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { handleComboChat } from "open-sse/services/combo.js";
import * as log from "../utils/logger.js";
import { withKeyAdmission } from "../services/keyAdmission.js";
import { recordModalityUsage, estimateTokensFromText } from "../services/modalityUsage.js";
import { requestIdFromRequest, attachRequestId } from "../utils/requestId.js";

// Derived from providers.js: any TTS provider not noAuth requires stored credentials
const CREDENTIALED_PROVIDERS = new Set(
  Object.entries(AI_PROVIDERS)
    .filter(([, p]) => p.serviceKinds?.includes("tts") && !p.noAuth && p.ttsConfig?.authType !== "none")
    .map(([id]) => id)
);

export async function handleTts(request) {
  const requestId = requestIdFromRequest(request);
  const response = await withKeyAdmission(request, () => handleTtsImpl(request, requestId));
  return attachRequestId(response, requestId);
}

async function handleTtsImpl(request, requestId = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  const modelStr = body.model;
  const responseFormat = url.searchParams.get("response_format") || body.response_format || "mp3"; // mp3 (default) | json
  const language = body.language || ""; // Optional language hint (currently used by Gemini)
  const style = body.style || ""; // Optional style/voice instructions (e.g. Xiaomi MiMo)
  log.request("POST", `${url.pathname} | ${modelStr} | format=${responseFormat}${language ? ` | lang=${language}` : ""}`);

  const apiKey = extractApiKey(request);
  const usageCtx = { apiKey, endpoint: url.pathname, requestId };
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!body.input) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: input");

  // Per-key access control: requested target, before combo expansion.
  const keyAccessDenied = await enforceKeyAccess(await getKeyAccessContext(request), modelStr);
  if (keyAccessDenied) return keyAccessDenied;

  // Combo expansion: model may be a combo name → run fallback/round-robin across models
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("TTS", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleModelTts(b, m, responseFormat, language, style, usageCtx),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
    });
  }

  return handleSingleModelTts(body, modelStr, responseFormat, language, style, usageCtx);
}

// G9: TTS providers report no token usage, so spend is estimated from
// input text at chars/4 (see modalityUsage.js) and marked "estimated" in
// the usage row — token quotas move, and the estimate is visible, never
// presented as a provider report.
async function handleSingleModelTts(body, modelStr, responseFormat, language, style, usageCtx = {}) {
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;
  log.info("ROUTING", `Provider: ${provider}, Voice: ${model}`);

  // noAuth providers — no credential needed
  if (!CREDENTIALED_PROVIDERS.has(provider)) {
    const result = await handleTtsCore({ provider, model, input: body.input, responseFormat, language, style });
    if (result.success) {
      recordModalityUsage({
        provider, model, connectionId: null, ...usageCtx,
        tokens: { prompt_tokens: estimateTokensFromText(body.input), completion_tokens: 0 },
        meta: { accrual: "estimated", basis: "input chars/4" },
      });
      return result.response;
    }
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "TTS failed");
  }

  // Credentialed providers — fallback loop (same pattern as embeddings)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  // Bound the account-retry loop: without a cap, a campaign-wide failure
  // grinds the whole pool (chat has had this cap; the modality handlers
  // did not). Null cap = disabled, same as chat.
  const settings = await getSettings();
  const attemptLimiter = createAttemptLimiter(resolveComboMemberAttemptCap(settings, provider, model));

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    if (!credentials || credentials.allRateLimited) {
      // ollama-local needs no credentials: synthesize locally on first
      // attempt (upstream port), with the same G9 estimated-usage row as
      // the other TTS success paths.
      if (provider === "ollama-local" && excludeConnectionIds.size === 0 && !credentials?.allRateLimited) {
        const result = await handleTtsCore({ provider, model, input: body.input, credentials: null, responseFormat, language, style });
        if (result.success) {
          recordModalityUsage({
            provider, model, connectionId: null, ...usageCtx,
            tokens: { prompt_tokens: estimateTokensFromText(body.input), completion_tokens: 0 },
            meta: { accrual: "estimated", basis: "input chars/4" },
          });
          return result.response;
        }
        return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "TTS failed");
      }
      return accountExhaustedResponse({
        credentials, excludeSize: excludeConnectionIds.size, lastError, lastStatus,
        scope: `${provider}/${model}`, provider,
        noCredentialsMessage: `No credentials for provider: ${provider}`,
      });
    }

    log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

    const result = await handleTtsCore({ provider, model, input: body.input, credentials, responseFormat, language, style });

    if (result.success) {
      recordModalityUsage({
        provider, model, connectionId: credentials.connectionId, ...usageCtx,
        tokens: { prompt_tokens: estimateTokensFromText(body.input), completion_tokens: 0 },
        meta: { accrual: "estimated", basis: "input chars/4" },
      });
      return result.response;
    }

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model);
    if (shouldFallback) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      attemptLimiter.recordFailure();
      if (attemptLimiter.exceeded) {
        log.warn("TTS", `Attempt cap reached (${attemptLimiter.failures} failed accounts), returning last error`);
      } else {
        continue;
      }
    }
    return result.response || errorResponse(result.status, result.error);
  }
}
