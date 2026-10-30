import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { resolveComboMemberAttemptCap, createAttemptLimiter, accountExhaustedResponse } from "../services/memberFailover.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { getKeyAccessContext, enforceKeyAccess } from "../services/keyAccess.js";
import { handleImageGenerationCore } from "open-sse/handlers/imageGenerationCore.js";
import { getImageAdapter } from "open-sse/handlers/imageProviders/index.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { handleComboChat } from "open-sse/services/combo.js";
import * as log from "../utils/logger.js";
import { withKeyAdmission } from "../services/keyAdmission.js";
import { requestIdFromRequest, attachRequestId } from "../utils/requestId.js";
import { saveRequestUsage } from "@/lib/usageDb.js";
import { recordModalityUsage } from "../services/modalityUsage.js";

// Providers that don't require credentials (noAuth)
const NO_AUTH_PROVIDERS = new Set(["sdwebui", "comfyui", "veoaifree-web"]);

// Returns true when a usage row was actually written, so the caller can
// tell a reported-usage success from a no-usage success (G9 fallback below).
function recordImageRequestUsage({ provider, model, connectionId, apiKey, endpoint, usage, requestId }) {
  if (!usage || typeof usage !== "object") return false;
  const promptTokens = usage.prompt_tokens;
  const completionTokens = usage.completion_tokens;
  if (!Number.isSafeInteger(promptTokens) || promptTokens < 0 ||
      !Number.isSafeInteger(completionTokens) || completionTokens < 0) {
    return false;
  }

  saveRequestUsage({
    provider,
    model,
    connectionId: connectionId || undefined,
    apiKey: apiKey || undefined,
    endpoint: endpoint || null,
    tokens: usage,
    status: "success",
    requestId: requestId || undefined,
    meta: { accrual: "reported" },
  }).catch(() => {});
  return true;
}

/**
 * Handle image generation request
 * @param {Request} request
 */
export async function handleImageGeneration(request) {
  const requestId = requestIdFromRequest(request);
  const response = await withKeyAdmission(request, () => handleImageGenerationImpl(request, requestId));
  return attachRequestId(response, requestId);
}

async function handleImageGenerationImpl(request, requestId = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  const preferredConnectionId = request.headers.get("x-connection-id") || null;
  const wantsStream = (request.headers.get("accept") || "").includes("text/event-stream");
  const binaryOutput = url.searchParams.get("response_format") === "binary";
  const modelStr = body.model;

  const apiKey = extractApiKey(request);
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!body.prompt) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt");

  // Per-key access control: requested target, before combo expansion.
  const keyAccessDenied = await enforceKeyAccess(await getKeyAccessContext(request), modelStr);
  if (keyAccessDenied) return keyAccessDenied;

  // Combo expansion: model may be a combo name → run fallback/round-robin across models
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("IMAGE", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleModelImage(b, m, { wantsStream, binaryOutput, preferredConnectionId, apiKey, endpoint: url.pathname, requestId }),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
    });
  }

  return handleSingleModelImage(body, modelStr, { wantsStream, binaryOutput, preferredConnectionId, apiKey, endpoint: url.pathname, requestId });
}

async function handleSingleModelImage(body, modelStr, { wantsStream, binaryOutput, preferredConnectionId, apiKey, endpoint, requestId } = {}) {
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;

  // noAuth providers — no credential needed
  if (NO_AUTH_PROVIDERS.has(provider)) {
    const result = await handleImageGenerationCore({
      body,
      modelInfo: { provider, model },
      credentials: null,
      binaryOutput,
    });
    // G9: noAuth image adapters report no token usage, so a successful
    // generation records a request-only row (visible, moves no quota —
    // there is no token or USD figure to count).
    if (result.success) {
      recordModalityUsage({
        provider, model, connectionId: null, apiKey, endpoint, requestId,
        meta: { accrual: "request-only", reason: "provider reports no token usage" },
      });
      return result.response;
    }
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "Image generation failed");
  }

  // Credentialed providers — fallback loop
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  // Bound the account-retry loop: without a cap, a campaign-wide failure
  // grinds the whole pool (chat has had this cap; the modality handlers
  // did not). Null cap = disabled, same as chat.
  const settings = await getSettings();
  const attemptLimiter = createAttemptLimiter(resolveComboMemberAttemptCap(settings, provider, model));

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { preferredConnectionId });

    if (!credentials || credentials.allRateLimited) {
      return accountExhaustedResponse({
        credentials, excludeSize: excludeConnectionIds.size, lastError, lastStatus,
        scope: `${provider}/${model}`, provider,
        noCredentialsMessage: `No credentials for provider: ${provider}`,
      });
    }

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Skip accounts the adapter knows cannot generate images (e.g. ChatGPT Free on codex)
    // without locking them: they stay usable for chat.
    const adapter = getImageAdapter(provider);
    if (adapter?.canUseCredentials && !adapter.canUseCredentials(refreshedCredentials)) {
      log.info("IMAGE", `[${provider}/${model}] skip connection ${credentials.connectionId.slice(0, 8)}: plan not entitled to image generation`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = lastError || "No account entitled to image generation (ChatGPT Free plans are not supported)";
      lastStatus = lastStatus || HTTP_STATUS.FORBIDDEN;
      continue;
    }

    let usageRecorded = false;
    const result = await handleImageGenerationCore({
      body,
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      streamToClient: wantsStream,
      binaryOutput,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          accessToken: newCreds.accessToken,
          refreshToken: newCreds.refreshToken,
          providerSpecificData: newCreds.providerSpecificData,
          testStatus: "active"
        });
      },
      onUsage: (usage) => {
        if (recordImageRequestUsage({
          provider,
          model,
          connectionId: credentials.connectionId,
          apiKey,
          endpoint,
          usage,
          requestId,
        })) usageRecorded = true;
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        // Cookies that rotate on use (Clerk `__client`) are mutated in place by
        // the executor — persist the new value so the chain does not drift.
        if (refreshedCredentials.apiKey && refreshedCredentials.apiKey !== credentials.apiKey) {
          await updateProviderCredentials(credentials.connectionId, { apiKey: refreshedCredentials.apiKey });
        }
      }
    });

    // G9: when the adapter reported no usage and this is not a stream
    // (a streaming response may still report usage while delivering, so a
    // fallback row here could double-count — streaming no-usage images
    // stay unrecorded and are disclosed as such), record a request-only
    // row so the generation is at least visible in usage history.
    if (result.success) {
      if (!wantsStream && !usageRecorded) {
        recordModalityUsage({
          provider, model, connectionId: credentials.connectionId, apiKey, endpoint, requestId,
          meta: { accrual: "request-only", reason: "provider reports no token usage" },
        });
      }
      return result.response;
    }

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model);

    if (shouldFallback) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      attemptLimiter.recordFailure();
      if (attemptLimiter.exceeded) {
        log.warn("IMAGE", `Attempt cap reached (${attemptLimiter.failures} failed accounts), returning last error`);
      } else {
        continue;
      }
    }

    return result.response;
  }
}
