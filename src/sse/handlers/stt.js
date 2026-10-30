import {
  extractApiKey, isValidApiKey,
  getProviderCredentials, markAccountUnavailable, clearAccountError,
} from "../services/auth.js";
import { resolveComboMemberAttemptCap, createAttemptLimiter, accountExhaustedResponse } from "../services/memberFailover.js";
import { getSettings, getCustomModels } from "@/lib/localDb";
import { getModelInfo } from "../services/model.js";
import { getKeyAccessContext, enforceKeyAccessResolved } from "../services/keyAccess.js";
import { handleSttCore } from "open-sse/handlers/sttCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import * as log from "../utils/logger.js";
import { withKeyAdmission } from "../services/keyAdmission.js";
import { recordModalityUsage, estimateTokensFromText } from "../services/modalityUsage.js";
import { requestIdFromRequest, attachRequestId } from "../utils/requestId.js";
import { checkAndRefreshToken } from "../services/tokenRefresh.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy.js";

// G9: STT providers report no token usage and audio duration is not
// decoded here, so spend is estimated from the transcript text at
// chars/4 (see modalityUsage.js) and marked "estimated". The response
// is cloned so measuring the transcript never consumes the client's copy.
function recordSttUsage(response, { provider, model, connectionId, usageCtx }) {
  const base = { provider, model, connectionId, ...usageCtx };
  try {
    response.clone().text().then((txt) => {
      recordModalityUsage({
        ...base,
        tokens: { prompt_tokens: 0, completion_tokens: estimateTokensFromText(txt) },
        meta: { accrual: "estimated", basis: "transcript chars/4" },
      });
    }).catch(() => {
      recordModalityUsage({ ...base, meta: { accrual: "request-only", reason: "transcript unreadable" } });
    });
  } catch {
    recordModalityUsage({ ...base, meta: { accrual: "request-only", reason: "transcript unreadable" } });
  }
}

// Providers requiring credentials for STT
const CREDENTIALED_PROVIDERS = new Set(
  Object.entries(AI_PROVIDERS)
    .filter(([, p]) => p.serviceKinds?.includes("stt") && !p.noAuth && p.sttConfig?.authType !== "none")
    .map(([id]) => id)
);

// Custom-model transport marker: models registered through
// /api/models/custom may pin a specialized STT transport (e.g.
// "gemini-live"). The engine dispatches on the marker itself, so the app
// layer only resolves it — same getModelInfo-style provider+model pairing,
// restricted to type "stt" records.
async function resolveCustomModelTransport(provider, model) {
  try {
    const customModels = await getCustomModels();
    const hit = customModels.find((c) => c && c.type === "stt"
      && c.providerAlias === provider && c.id === model
      && typeof c.transport === "string" && c.transport.trim());
    return hit ? hit.transport.trim() : null;
  } catch {
    return null; // DB unreadable → built-in registry marker still applies
  }
}

export async function handleStt(request) {
  const requestId = requestIdFromRequest(request);
  const response = await withKeyAdmission(request, () => handleSttImpl(request, requestId));
  return attachRequestId(response, requestId);
}

async function handleSttImpl(request, requestId = null) {
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid multipart form data");
  }

  const modelStr = formData.get("model");
  log.request("POST", `/v1/audio/transcriptions | ${modelStr}`);

  const apiKey = extractApiKey(request);
  const usageCtx = { apiKey, endpoint: "/v1/audio/transcriptions", requestId };
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!formData.get("file")) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: file");

  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;
  if (provider === "codex" && model !== "transcribe") return errorResponse(400, "Use model cx/transcribe for Codex STT");

  // Per-key access control: checked before any credential lookup.
  const keyAccessDenied = await enforceKeyAccessResolved(await getKeyAccessContext(request), modelStr, provider, model);
  if (keyAccessDenied) return keyAccessDenied;

  log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);

  const modelTransport = await resolveCustomModelTransport(provider, model);

  // noAuth providers
  if (!CREDENTIALED_PROVIDERS.has(provider)) {
    const result = await handleSttCore({ provider, model, formData, sttConfig: AI_PROVIDERS[provider]?.sttConfig, transport: modelTransport });
    if (result.success) {
      recordSttUsage(result.response, { provider, model, connectionId: null, usageCtx });
      return result.response;
    }
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "STT failed");
  }

  // Credentialed — fallback loop
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  // Bound the account-retry loop: without a cap, a campaign-wide failure
  // grinds the whole pool (chat has had this cap; the modality handlers
  // did not). Null cap = disabled, same as chat.
  const attemptLimiter = createAttemptLimiter(resolveComboMemberAttemptCap(settings, provider, model));

  while (true) {
    let credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    if (!credentials || credentials.allRateLimited) {
      return accountExhaustedResponse({
        credentials, excludeSize: excludeConnectionIds.size, lastError, lastStatus,
        scope: `${provider}/${model}`, provider,
        noCredentialsMessage: `No credentials for provider: ${provider}`,
      });
    }

    log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

    let result;
    try {
      const isCodex = provider === "codex";
      if (isCodex) credentials = await checkAndRefreshToken(provider, credentials);
      const proxyOptions = isCodex
        ? await resolveConnectionProxyConfig(credentials._connection?.providerSpecificData || credentials.providerSpecificData)
        : undefined;
      const args = { provider, model, formData, credentials, sttConfig: AI_PROVIDERS[provider]?.sttConfig, transport: modelTransport, signal: request.signal, proxyOptions };
      result = await handleSttCore(args);
      if (isCodex && result.status === 401 && credentials.refreshToken && !request.signal.aborted) {
        const previous = credentials.accessToken;
        credentials = await checkAndRefreshToken(provider, credentials, { force: true });
        if (credentials.accessToken !== previous) result = await handleSttCore({ ...args, credentials });
      }
      if (result.success) {
        if (isCodex) await clearAccountError(credentials.connectionId, credentials, model);
        recordSttUsage(result.response, { provider, model, connectionId: credentials.connectionId, usageCtx });
        return result.response;
      }
    } catch {
      return errorResponse(HTTP_STATUS.BAD_GATEWAY, "STT credential or transport failure");
    }

    if (request.signal.aborted) return errorResponse(504, "Transcription cancelled");
    // Bad audio / unsupported parameters are client errors, not broken accounts.
    if (provider === "codex" && [400, 413, 504].includes(result.status)) {
      return result.response || errorResponse(result.status, result.error);
    }

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model);
    if (shouldFallback) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      attemptLimiter.recordFailure();
      if (attemptLimiter.exceeded) {
        log.warn("STT", `Attempt cap reached (${attemptLimiter.failures} failed accounts), returning last error`);
      } else {
        continue;
      }
    }
    return result.response || errorResponse(result.status, result.error);
  }
}
