import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
import { resolveComboMemberAttemptCap } from "../services/memberFailover.js";
import { dispatchCombo, createVariantHelpers, withBreakerSuccess } from "../services/comboDispatch.js";
import { getSettings, getApiKeyByKey, resolvePromptInjections, resolveBriefLevel, recordRtkSavings, getInjectVariants, getProviderConnections } from "@/lib/localDb";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { parseAutoTarget, buildAutoCandidates } from "../services/autoRouting.js";
import { getModelInfo, getComboModels, parseModel } from "../services/model.js";
import { recordProviderSuccess } from "../services/providerBreaker.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { upstreamResponseHeaders } from "open-sse/utils/upstreamHeaders.js";
import { handleComboChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
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
import { withKeyAdmission, recheckKeyQuotaAfterCompletion } from "../services/keyAdmission.js";
import { requestIdFromRequest, attachRequestId } from "../utils/requestId.js";

export async function handleChat(request, clientRawRequest = null) {
  // D6: one id for this client request. It rides on clientRawRequest
  // into every single-model attempt (combo members included, panel
  // stripping preserves it via object spread) so chatCore can stamp it
  // on usage rows and request-detail records, and it comes back to the
  // client on every response — success, error, or stream — via header.
  const requestId = requestIdFromRequest(request);
  const response = await withKeyAdmission(request, () => handleChatImpl(request, clientRawRequest, requestId), recheckKeyQuotaAfterCompletion);
  return attachRequestId(response, requestId);
}

// Per-combo member pins live in comboDispatch.js (memberPinFor) so the
// top-level and nested combo branches share one definition.

// Capacity ordering reads every provider's connections; cache the snapshot
// briefly so a capacity-strategy request doesn't scan the whole table each
// time. Staleness only affects ORDER, never correctness — failover still
// tries every member, and locks are re-checked at credential selection.
let capacityConnectionsCache = { at: 0, data: [] };
const CAPACITY_CONNECTIONS_TTL_MS = 10_000;
async function getCapacityConnections() {
  const now = Date.now();
  if (now - capacityConnectionsCache.at < CAPACITY_CONNECTIONS_TTL_MS) return capacityConnectionsCache.data;
  const data = await getProviderConnections().catch(() => []);
  capacityConnectionsCache = { at: now, data };
  return data;
}

// withBreakerSuccess lives in comboDispatch.js (shared with dispatchCombo).

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
async function handleChatImpl(request, clientRawRequest = null, requestId = null) {
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
  // D6 thread: the request id travels on clientRawRequest so it reaches
  // handleSingleModelChat (and from there chatCore) for every branch —
  // top-level combo, nested combo, solo, fusion panels — without a new
  // positional parameter on every call site.
  if (requestId) clientRawRequest.requestId = requestId;
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

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Scored auto-routing (P3-25): `auto:<intent>` is not a real model, so the
  // literal target skips the per-key target gate — the RESOLVED candidates
  // are gated instead (filterAdapterModels below), so a restricted key only
  // ever routes to models its allow-list names.
  const autoIntent = parseAutoTarget(modelStr);
  const keyAccess = await getKeyAccessContext(request);
  if (!autoIntent) {
    const keyAccessDenied = await enforceKeyAccess(keyAccess, modelStr);
    if (keyAccessDenied) return keyAccessDenied;
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Auto-routing resolves to a ranked candidate list and falls back through
  // it in order, like a combo with strategy "fallback" (same member cap).
  if (autoIntent) {
    const connections = await getProviderConnections().catch(() => []);
    const disabled = await getDisabledModels().catch(() => ({}));
    let candidates = buildAutoCandidates({ intent: autoIntent, connections, disabled });
    candidates = await filterAdapterModels(keyAccess, candidates, []);
    if (candidates.length === 0) {
      log.warn("CHAT", `Auto-routing "${modelStr}" found no routable model`);
      return errorResponse(
        HTTP_STATUS.NOT_FOUND,
        keyAccess
          ? `No model allowed for this key matches auto:${autoIntent}`
          : `No connected provider offers a model for auto:${autoIntent} — connect a provider first`,
      );
    }
    log.info("CHAT", `Auto-routing "${modelStr}" → [${candidates.join(", ")}]`);
    return handleComboChat({
      body,
      models: candidates,
      handleSingleModel: withBreakerSuccess((b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, null, modelStr, resolveComboMemberAttemptCap(settings))),
      log,
      comboName: modelStr,
      comboStrategy: "fallback",
      comboStickyLimit: settings.comboStickyRoundRobinLimit,
      sessionId,
    });
  }

  // Check if model is a combo (has multiple models with fallback).
  // Strategy, capacity ordering, fusion and fallback dispatch all live
  // in comboDispatch.js (P4-33) — the same module the nested branch uses.
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    return dispatchCombo({
      body,
      comboName: modelStr,
      comboModels,
      settings,
      apiKey,
      keyAccess,
      requiredCapabilities,
      variants: await getInjectVariants().catch(() => ({})),
      clientRawRequest,
      request,
      log,
      sessionId,
      handleSingleModel: handleSingleModelChat,
      getCapacityConnections,
      recordBreakerSuccess: true,
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  // Same variant rules as the combo branches: a pool model that names a variant
  // is judged by its backing model, and carries its bare name so its prompt fires.
  const { memberInjectName: soloInjectName, variantBacking: soloVariantBacking } =
    createVariantHelpers(await getInjectVariants().catch(() => ({})), modelStr);
  const soloAugmented = await filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings, soloVariantBacking), [modelStr]);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        withBreakerSuccess(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, null, soloInjectName(m), resolveComboMemberAttemptCap(settings)),
          (m) => soloVariantBacking(m) || m,
        ),
        adapterAdded,
        soloVariantBacking
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings)
    });
  }

  const soloResult = await handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, contextMarker ? `${modelStr.slice(modelStr.indexOf("/") + 1)}[${contextMarker}]` : null);
  try {
    if (soloResult?.ok) {
      const target = soloVariantBacking(modelStr) || modelStr;
      const p = parseModel(target);
      if (p?.provider) recordProviderSuccess(p.provider);
    }
  } catch { /* breaker bookkeeping must not fail the request */ }
  return soloResult;
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
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, requestedModel = null, injectModelName = null, comboMemberAttemptCap = null, abortSignal = null, pinnedConnectionId = null) {
  // Direct variant pick without a backing combo: a bare name that names a
  // variant routes straight to its backing model, with the variant name
  // carried so its prompt still fires. This covers both direct picks and
  // combo members that name variants — no combo object is created per
  // variant, so the Kombinasi page shows only combos the user made.
  if (typeof modelStr === "string" && !modelStr.includes("/")) {
    const directVariants = await getInjectVariants().catch(() => ({}));
    const directVariant = directVariants[modelStr];
    if (directVariant && typeof directVariant.model === "string" && directVariant.model.includes("/")) {
      // A direct pick used to run through its single-member combo, so it
      // inherited the member attempt cap; without it the pick grinds the
      // whole pool (a dahl direct pick timed out at 150s). Resolve the
      // cap here when the caller passed none (top-level picks pass null).
      const directCap = comboMemberAttemptCap ?? resolveComboMemberAttemptCap(await getSettings().catch(() => ({})));
      return handleSingleModelChat({ ...body, model: directVariant.model }, directVariant.model, clientRawRequest, request, apiKey, requestedModel, modelStr, directCap, abortSignal, pinnedConnectionId);
    }
  }
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      // Nested combo (a combo member that is itself a combo): the access
      // decision was made on the outer target; only drop adapter models
      // the key may not call. One deliberate difference from the
      // top-level branch is preserved: no breaker-success recording
      // (recordBreakerSuccess: false) — see comboDispatch.js.
      // Variant fallback: a member that names a variant carries its own
      // bare name; otherwise the outer requested name is kept, so the
      // variant pick's prompt still fires. That is why the fallback
      // name here is (injectModelName || modelStr), not modelStr.
      const chatSettings = await getSettings();
      const nestedSession = resolveSessionIdentity({ headers: clientRawRequest?.headers, body });
      return dispatchCombo({
        body,
        comboName: modelStr,
        comboModels,
        settings: chatSettings,
        apiKey,
        keyAccess: await getKeyAccessContext(request),
        requiredCapabilities: detectRequiredCapabilities(body),
        variants: await getInjectVariants().catch(() => ({})),
        variantFallbackName: injectModelName || modelStr,
        clientRawRequest,
        request,
        log,
        sessionId: nestedSession?.sessionId || null,
        handleSingleModel: handleSingleModelChat,
        getCapacityConnections,
        recordBreakerSuccess: false,
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Per-provider/per-model cap override (P3-30): the caller passes the
  // global cap, but the member that actually serves is this provider/
  // model, so its override wins here. A null incoming cap means the
  // caller deliberately runs uncapped (solo single-model requests) and
  // stays null — the override only refines a cap that already exists.
  // The fresh settings read also covers direct-variant recursion, where
  // the caller resolved the cap before the backing model was known.
  if (comboMemberAttemptCap !== null) {
    comboMemberAttemptCap = resolveComboMemberAttemptCap(
      await getSettings().catch(() => ({})),
      provider,
      model,
    );
  }

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
  // Smart member failover: failed accounts for this member inside this one
  // request. Once the cap is hit, the member gives up so the combo can move
  // to its next member at once instead of grinding the whole pool.
  let memberFallbackFailures = 0;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { requestedModel: requestedModel || model, preferredConnectionId: pinnedConnectionId || undefined });

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
      externalSignal: abortSignal,
      requestId: clientRawRequest?.requestId || null,
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
            // A flaky retry spends an account attempt too (the account
            // did serve, just garbage), so it counts toward the member
            // cap — otherwise a member could burn its cap on hard
            // failures plus up to maxRetries extra flaky retries. When
            // the cap is hit the member gives up and the last flaky
            // response is rescued, the same way it is when the pool
            // runs out.
            memberFallbackFailures++;
            if (comboMemberAttemptCap !== null && memberFallbackFailures >= comboMemberAttemptCap) {
              log.warn("COMBO", `Member ${provider}/${model} failed ${memberFallbackFailures} accounts in this request — moving to next combo member`);
              return withFlakyRetriesHeader(result.response, flakyAttempts);
            }
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
    let shouldFallback;
    if (provider === "antigravity" && quotaResetMs) {
      shouldFallback = true;
    } else {
      try {
        shouldFallback = (await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, resetsAtMs)).shouldFallback;
      } catch (err) {
        // Fail open: bookkeeping must never kill the request — fall back to
        // the next account even if the lock could not be recorded.
        log.warn("FALLBACK", `markAccountUnavailable threw, falling back anyway: ${err?.message || err}`);
        shouldFallback = true;
      }
    }

    if (shouldFallback) {
      log.warn("FALLBACK", `${credentials.connectionName} failed (${result.status}${log.describeStatus?.(result.status) ? ` ${log.describeStatus(result.status)}` : ""}) → trying next account`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      lastHeaders = upstreamResponseHeaders(result.response?.headers);
      // Smart member failover: a lane whose accounts keep failing (e.g. a
      // campaign-wide 429) stops here — the combo moves to its next member
      // at once instead of grinding the rest of this pool.
      memberFallbackFailures++;
      if (comboMemberAttemptCap !== null && memberFallbackFailures >= comboMemberAttemptCap) {
        log.warn("COMBO", `Member ${provider}/${model} failed ${memberFallbackFailures} accounts in this request — moving to next combo member`);
        return result.response;
      }
      continue;
    }

    return result.response;
  }
}
