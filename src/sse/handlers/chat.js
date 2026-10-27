import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
import { resolveComboStrategy } from "../services/pairStrategy.js";
import { getSettings, getApiKeyByKey, resolvePromptInjections, resolveBriefLevel, recordRtkSavings, checkKeyQuota, getKeyLimits, getKeyUsageInWindow, getInjectVariants } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { upstreamResponseHeaders } from "open-sse/utils/upstreamHeaders.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import { resolveSessionIdentity } from "open-sse/utils/sessionManager.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import { getKeyAccessContext, enforceKeyAccess, filterAdapterModels } from "../services/keyAccess.js";
import { resolveAntiFlakyConfig, inspectChatResponse, inspectChatResponseFull } from "open-sse/rtk/flakyGuard.js";
import { peekKeyLimits, admitKeyRequest } from "@/lib/keyRateLimiter.js";

// 9Router Pro: per-key rate limits (RPM/TPM/RPH/RPD/max concurrent) — soft
// admission around the chat handler, fails open exactly like the token
// quota: a limiter error never blocks a chat. RPM/RPH/RPD/concurrency are
// tracked in memory; TPM is a soft DB check over the last minute of usage.
const LIMIT_MESSAGES = {
  rpm: (v) => `API key rate limit exceeded (${v.used}/${v.limit} requests in the last minute)`,
  rph: (v) => `API key rate limit exceeded (${v.used}/${v.limit} requests in the last hour)`,
  rpd: (v) => `API key rate limit exceeded (${v.used}/${v.limit} requests in the last 24 hours)`,
  concurrency: (v) => `API key concurrency limit exceeded (${v.limit} requests already in flight)`,
};

async function admitChatForKeyLimits(request) {
  const apiKey = extractApiKey(request);
  if (!apiKey) return null;
  const keyRecord = await getApiKeyByKey(apiKey);
  if (!keyRecord) return null;
  const limits = await getKeyLimits(keyRecord.id);
  if (!limits) return null;
  if (limits.tpm) {
    const tpmUsed = await getKeyUsageInWindow(apiKey, 1 / 60);
    if (tpmUsed >= limits.tpm) {
      log.warn("LIMIT", `Key "${keyRecord.name}" over TPM (${tpmUsed}/${limits.tpm})`);
      return { response: errorResponse(429, `API key rate limit exceeded (${tpmUsed}/${limits.tpm} tokens in the last minute)`, { "Retry-After": "60" }) };
    }
  }
  const verdict = peekKeyLimits(keyRecord.id, limits);
  if (verdict.blocked) {
    log.warn("LIMIT", `Key "${keyRecord.name}" over ${verdict.kind} (${verdict.used}/${verdict.limit})`);
    return { response: errorResponse(429, LIMIT_MESSAGES[verdict.kind](verdict), { "Retry-After": String(verdict.retryAfterSec) }) };
  }
  return { release: admitKeyRequest(keyRecord.id) };
}

function wrapResponseWithRelease(response, release) {
  if (!response || !response.body || typeof response.body.pipeThrough !== "function") {
    release();
    return response;
  }
  let done = false;
  const finish = () => {
    if (!done) {
      done = true;
      release();
    }
  };
  try {
    const stream = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) { controller.enqueue(chunk); },
      flush() { finish(); },
      cancel() { finish(); },
    }));
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch {
    finish();
    return response;
  }
}

export async function handleChat(request, clientRawRequest = null) {
  let release = null;
  try {
    const admission = await admitChatForKeyLimits(request);
    if (admission?.response) return admission.response;
    release = admission?.release || null;
  } catch {
    release = null;
  }
  let response;
  try {
    response = await handleChatImpl(request, clientRawRequest);
  } catch (err) {
    if (release) release();
    throw err;
  }
  if (release) return wrapResponseWithRelease(response, release);
  return response;
}
import { resolveSmartChoice } from "../services/systemoneRouter.js";

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
async function handleChatImpl(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  const session = resolveSessionIdentity({ headers: clientRawRequest?.headers, body });
  const sessionId = session?.sessionId || null;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  // 9Router Pro: per-key token quota — soft pre-check, fails open
  if (apiKey) {
    try {
      const keyRecord = await getApiKeyByKey(apiKey);
      if (keyRecord) {
        const verdict = await checkKeyQuota(keyRecord.id, apiKey);
        if (verdict.blocked) {
          log.warn("QUOTA", `Key "${keyRecord.name}" over quota (${verdict.used}/${verdict.quota.limit})`);
          return errorResponse(429, `API key token quota exceeded (${verdict.used}/${verdict.quota.limit} tokens in the last ${verdict.quota.windowHours}h)`);
        }
      }
    } catch {}
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Per-key access control: a restricted key may call only its listed combos and
  // models. Checked once on the requested target, before bypass, combo expansion
  // and any credential lookup; an allowed combo grants the members it routes to.
  const keyAccess = await getKeyAccessContext(request);
  const keyAccessDenied = await enforceKeyAccess(keyAccess, modelStr);
  if (keyAccessDenied) return keyAccessDenied;

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Same rule as the nested combo branch below: a member that names
    // a variant carries its own bare name so its prompt fires; other
    // members keep the requested combo name.
    const topInjectVariants = await getInjectVariants().catch(() => ({}));
    const topMemberInjectName = (m) =>
      (typeof m === "string" && !m.includes("/") && topInjectVariants[m]
        ? m
        : modelStr);
    // Capacity pools may hold variants: judge them by their backing model,
    // and keep the variant name in the pool so its prompt still fires.
    const topVariantBacking = (m) =>
      (typeof m === "string" && !m.includes("/") && topInjectVariants[m]
        ? topInjectVariants[m].model || null
        : null);
    // Check for combo-specific strategy first, fallback to global;
    // a multi-model pair defaults to round-robin (see pairStrategy.js)
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = await resolveComboStrategy(modelStr, comboModels, settings, apiKey);
    const augmentedModels = await filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings, topVariantBacking), comboModels);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, null, topMemberInjectName(m));
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    const comboCfg = comboStrategies[modelStr] || {};
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, null, topMemberInjectName(m)),
        adapterAdded,
        topVariantBacking
      ),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
      sessionId,
      smartPolicy: comboCfg.smartPolicy || "smart",
      sessionSticky: comboCfg.sessionSticky !== false,
      confidenceThreshold: typeof comboCfg.confidenceThreshold === "number" ? comboCfg.confidenceThreshold : 0.8,
      resolveSmartChoice: comboStrategy === "smart"
        ? (b, m) => resolveSmartChoice({
            body: b,
            models: m,
            routerModel: comboCfg.routerModel,
            log,
          })
        : null,
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  // Same variant rules as the combo branches: a pool model that names a variant
  // is judged by its backing model, and carries its bare name so its prompt fires.
  const soloInjectVariants = await getInjectVariants().catch(() => ({}));
  const soloVariantBacking = (m) =>
    (typeof m === "string" && !m.includes("/") && soloInjectVariants[m]
      ? soloInjectVariants[m].model || null
      : null);
  const soloInjectName = (m) =>
    (typeof m === "string" && !m.includes("/") && soloInjectVariants[m]
      ? m
      : modelStr);
  const soloAugmented = await filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings, soloVariantBacking), [modelStr]);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, null, soloInjectName(m)),
        adapterAdded,
        soloVariantBacking
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings)
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, contextMarker ? `${modelStr.slice(modelStr.indexOf("/") + 1)}[${contextMarker}]` : null);
}

/**
 * Tag a response that only succeeded after Anti-Flaky retries, so the
 * recovery is observable to the client. Never throws.
 */
function withFlakyRetriesHeader(response, retries) {
  try {
    const headers = new Headers(response.headers);
    headers.set("x-9router-pro-flaky-retries", String(retries));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch {
    return response;
  }
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, requestedModel = null, injectModelName = null) {
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      // Variant members of a combo must inject like a direct variant
      // pick: carry the member's bare name when it names a variant,
      // otherwise keep the outer requested name (direct variant picks
      // rely on it through their single-member combo).
      const comboInjectVariants = await getInjectVariants().catch(() => ({}));
      const memberInjectName = (m) =>
        (typeof m === "string" && !m.includes("/") && comboInjectVariants[m]
          ? m
          : (injectModelName || modelStr));
      const nestedVariantBacking = (m) =>
        (typeof m === "string" && !m.includes("/") && comboInjectVariants[m]
          ? comboInjectVariants[m].model || null
          : null);
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global;
      // a multi-model pair defaults to round-robin (see pairStrategy.js)
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboStrategy = await resolveComboStrategy(modelStr, comboModels, chatSettings, apiKey);
      const requiredCapabilities = detectRequiredCapabilities(body);
      // Nested combo (a combo member that is itself a combo): the access decision
      // was made on the outer target; only drop adapter models the key may not call.
      const keyAccess = await getKeyAccessContext(request);
      const augmentedModels = await filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings, nestedVariantBacking), comboModels);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, null, memberInjectName(m));
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      const comboCfg = comboStrategies[modelStr] || {};
      const nestedSession = resolveSessionIdentity({ headers: clientRawRequest?.headers, body });
      const nestedSessionId = nestedSession?.sessionId || null;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, null, memberInjectName(m)),
          adapterAdded,
          nestedVariantBacking
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
        sessionId: nestedSessionId,
        smartPolicy: comboCfg.smartPolicy || "smart",
        sessionSticky: comboCfg.sessionSticky !== false,
        confidenceThreshold: typeof comboCfg.confidenceThreshold === "number" ? comboCfg.confidenceThreshold : 0.8,
        resolveSmartChoice: comboStrategy === "smart"
          ? (b, m) => resolveSmartChoice({
              body: b,
              models: m,
              routerModel: comboCfg.routerModel,
              log,
            })
          : null,
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;
  let lastHeaders = null;
  // Anti-Flaky Guard (9Router Pro): retries spent on 200-but-garbage
  // responses, plus the last such response as a rescue if the pool runs
  // out before a clean answer shows up.
  let flakyAttempts = 0;
  let lastFlakyResult = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { requestedModel: requestedModel || model });

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      // Anti-Flaky rescue: a flaky 200 we already hold beats an error.
      if (lastFlakyResult) return withFlakyRetriesHeader(lastFlakyResult.response, flakyAttempts);
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman, lastHeaders);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable", lastHeaders);
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    // Prompt Injection (9Router Pro): global → the API key's → the
    // variant's (matched by the bare custom name the user requested) →
    // the model+key's (matched by resolved provider/model). A variant
    // pick suppresses the model scopes, so the raw model name is never
    // disturbed by an injection.
    // Fail-open: resolvePromptInjections already swallows storage errors.
    const injectKeyRecord = apiKey ? await getApiKeyByKey(apiKey).catch(() => null) : null;
    const promptInjects = await resolvePromptInjections({
      apiKeyId: injectKeyRecord?.id || null,
      requestedModel: injectModelName || requestedModel || modelStr,
      resolvedModel: `${provider}/${model}`,
      bareModel: model,
    });
    // Brief Mode (9Router Pro): per-scope terseness level, same context.
    const briefLevel = await resolveBriefLevel({
      apiKeyId: injectKeyRecord?.id || null,
      requestedModel: injectModelName || requestedModel || modelStr,
      resolvedModel: `${provider}/${model}`,
      bareModel: model,
    });
    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      headroomTimeoutMs: chatSettings.headroomTimeoutMs,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      promptInjects,
      briefLevel,
      onRtkStats: (stats) => { try { recordRtkSavings(stats); } catch {} },
      customPromptEnabled: !!chatSettings.customPromptEnabled,
      customPrompt: chatSettings.customPrompt || "",
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      // Per-provider user overrides (custom headers / connect timeout) from settings
      providerOverrides: (chatSettings.providerOverrides || {})[provider] || null,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        // "Consecutive" strikes: a success clears the breaker for this pair.
        clearAntigravityStrikes(credentials.connectionId, model);
      }
    });

    if (result.success) {
      // Anti-Flaky Guard (9Router Pro): an HTTP 200 whose body is empty
      // or a degenerate repetition loop is retried on another account
      // instead of reaching the client. Fail-open: retries are capped by
      // settings, the account is NOT marked unavailable (the upstream
      // pool is flaky, the key is not necessarily bad), and the last
      // flaky response is rescued above if the pool runs out.
      const afConfig = resolveAntiFlakyConfig(chatSettings);
      if (afConfig.enabled && afConfig.maxRetries > 0) {
        // Streaming clients get the light probe (never held up);
        // document-style requests are judged whole — some executors
        // deliver them as a live stream carrying a single JSON body.
        const verdict = body?.stream === true
          ? await inspectChatResponse(result.response)
          : await inspectChatResponseFull(result.response);
        if (verdict.flaky) {
          lastFlakyResult = result;
          if (flakyAttempts < afConfig.maxRetries) {
            flakyAttempts++;
            log.warn("FLAKY", `[${provider}/${model}] ${verdict.reason} response from ${credentials.connectionName || credentials.connectionId} — retry ${flakyAttempts}/${afConfig.maxRetries} on another account`);
            excludeConnectionIds.add(credentials.connectionId);
            lastError = `Flaky (${verdict.reason}) response`;
            lastStatus = HTTP_STATUS.BAD_GATEWAY;
            continue;
          }
          log.warn("FLAKY", `[${provider}/${model}] ${verdict.reason} response — retries exhausted, passing through`);
        }
      }
      return flakyAttempts > 0 ? withFlakyRetriesHeader(result.response, flakyAttempts) : result.response;
    }

    // Antigravity 409/429: refresh live quota to get exact resetAt before locking
    let quotaResetMs = null;
    let resetsAtMs = result.resetsAtMs;
    if (provider === "antigravity" && (result.status === 409 || result.status === 429)) {
      quotaResetMs = await handleAntigravityQuotaError(
        credentials.connectionId, result.status, model,
        refreshedCredentials.accessToken, credentials.providerSpecificData
      );
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }

    // Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
    // Do not persist a modelLock_* for this path.
    const shouldFallback = provider === "antigravity" && quotaResetMs
      ? true
      : (await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, resetsAtMs)).shouldFallback;

    if (shouldFallback) {
      log.warn("FALLBACK", `${credentials.connectionName} failed (${result.status}${log.describeStatus?.(result.status) ? ` ${log.describeStatus(result.status)}` : ""}) → trying next account`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      lastHeaders = upstreamResponseHeaders(result.response?.headers);
      continue;
    }

    return result.response;
  }
}
