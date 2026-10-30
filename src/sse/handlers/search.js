import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { resolveComboMemberAttemptCap, createAttemptLimiter, accountExhaustedResponse } from "../services/memberFailover.js";
import { getSettings, getCombos } from "@/lib/localDb";
import { AI_PROVIDERS, resolveProviderId } from "@/shared/constants/providers.js";
import { handleSearchCore } from "open-sse/handlers/search/index.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";
import { withKeyAdmission } from "../services/keyAdmission.js";
import { requestIdFromRequest, attachRequestId } from "../utils/requestId.js";
import { recordModalityUsage } from "../services/modalityUsage.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { handleComboChat, getComboModelsFromData } from "open-sse/services/combo.js";
import { getKeyAccessContext, enforceKeyAccessProvider } from "../services/keyAccess.js";

/**
 * Handle web search request for the SSE/Next.js server.
 * Provider IS the model (no model field). Mirrors handleEmbeddings auth + fallback flow.
 *
 * @param {Request} request
 */
export async function handleSearch(request) {
  const requestId = requestIdFromRequest(request);
  const response = await withKeyAdmission(request, () => handleSearchImpl(request, requestId));
  return attachRequestId(response, requestId);
}

async function handleSearchImpl(request, requestId = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("SEARCH", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  // Accept either `provider` or `model` (UI sends `model` since provider IS the model for webSearch)
  const providerInput = body.provider || body.model;
  const query = body.query;

  log.request("POST", `${url.pathname} | ${providerInput}`);

  // Log API key (masked)
  const apiKey = extractApiKey(request);
  if (apiKey) {
    log.debug("AUTH", `API Key: ${log.maskKey(apiKey)}`);
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

  if (!providerInput || typeof providerInput !== "string") {
    log.warn("SEARCH", "Missing provider/model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: provider (or model)");
  }

  if (!query || typeof query !== "string" || !query.trim()) {
    log.warn("SEARCH", "Missing query");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: query");
  }

  // Combo expansion: providerInput may be a combo name → run fallback/round-robin across providers
  const combos = await getCombos();
  const comboModels = getComboModelsFromData(providerInput, combos);

  // Per-key access control: the provider IS the model here, so a
  // restricted key needs the provider id (or the combo) on its list.
  const keyAccessDenied = await enforceKeyAccessProvider(await getKeyAccessContext(request), providerInput, comboModels);
  if (keyAccessDenied) return keyAccessDenied;
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[providerInput]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("SEARCH", `Combo "${providerInput}" with ${comboModels.length} providers (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleProviderSearch(b, m, request, apiKey, settings, requestId),
      log,
      comboName: providerInput,
      comboStrategy,
      comboStickyLimit
    });
  }

  return handleSingleProviderSearch(body, providerInput, request, apiKey, settings, requestId);
}

// G9: search spend is USD-per-query (providerConfig.costPerQuery), not
// tokens, so it accrues via costOverride ("cost-only" in meta) — cost
// quotas count it, token quotas do not (there are no tokens to count).
// Search-via-chat providers have no costPerQuery, so they record a
// request-only row: visible in usage history, moving no quota.
async function handleSingleProviderSearch(body, providerInput, request, apiKey, settings, requestId = null) {
  const endpoint = new URL(request.url).pathname;
  // Defined inside so it closes over the resolved provider, the caller's
  // key, and the request id of this search.
  function recordSearchUsage(providerConfig, connectionId) {
    const cost = providerConfig?.costPerQuery;
    recordModalityUsage({
      provider: providerId, model: "search", connectionId, apiKey, endpoint, requestId,
      ...(Number.isFinite(cost) ? { costOverride: cost } : {}),
      meta: Number.isFinite(cost)
        ? { accrual: "cost-only", queries: 1 }
        : { accrual: "request-only", reason: "no costPerQuery configured" },
    });
  }
  const query = body.query;
  const providerId = resolveProviderId(providerInput);
  const resolvedProvider = AI_PROVIDERS[providerId];

  if (!resolvedProvider) {
    log.warn("SEARCH", "Unknown provider", { provider: providerInput });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unknown provider: ${providerInput}`);
  }

  const providerConfig = resolvedProvider.searchConfig;
  const supportsSearch = !!providerConfig || !!resolvedProvider.searchViaChat;

  if (!supportsSearch) {
    log.warn("SEARCH", "Provider does not support web search", { provider: providerId });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Provider ${providerId} does not support web search`);
  }

  if (providerInput !== providerId) {
    log.info("ROUTING", `${providerInput} → ${providerId}`);
  } else {
    log.info("ROUTING", `Provider: ${providerId}`);
  }

  // Sanitized body forwarded to core
  const coreBody = {
    query: query.trim(),
    provider: providerId,
    max_results: body.max_results,
    search_type: body.search_type,
    country: body.country,
    language: body.language,
    time_range: body.time_range,
    offset: body.offset,
    domain_filter: body.domain_filter,
    content_options: body.content_options,
    provider_options: body.provider_options
  };

  // No-auth providers (e.g. searxng) bypass credential lookup
  if (resolvedProvider.noAuth) {
    log.info("AUTH", `\x1b[32m${providerId} no-auth mode\x1b[0m`);
    const result = await handleSearchCore({
      body: coreBody,
      provider: resolvedProvider,
      providerConfig,
      credentials: null,
      log
    });
    if (result.success) {
      recordSearchUsage(providerConfig, null);
      return result.response;
    }
    return result.response;
  }

  // Credential + fallback loop
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  // Credential fallback: some search providers reuse the API key of a related
  // chat provider (e.g. ollama-search reuses the `ollama` chat key, zai-search
  // reuses the `glm` chat key). When the search provider has no own connection,
  // fall back to the linked provider's credentials.
  const fallbackProviderId = resolvedProvider.credentialFallback;

  // Lock scope for this handler. Without it markAccountUnavailable would write
  // an account-wide `__all` lock, which on the credentialFallback path takes
  // the shared chat key (e.g. glm) offline for chat as well. Must be passed to
  // getProviderCredentials too, so the lock is read back under the same key.
  const searchLockKey = `websearch:${providerId}`;

  // Bound the account-retry loop: without a cap, a campaign-wide failure
  // grinds the whole pool (chat has had this cap; the modality handlers
  // did not). Null cap = disabled, same as chat.
  const attemptLimiter = createAttemptLimiter(resolveComboMemberAttemptCap(settings, providerId));

  while (true) {
    // Provider that actually owns the connection in use — differs from
    // providerId once we fall back, and error locks must be attributed to it.
    let credentialProviderId = providerId;
    let credentials = await getProviderCredentials(providerId, excludeConnectionIds, searchLockKey);

    // Fall back to the related chat provider's credentials when this search
    // provider has none of its own (one key, chat + search).
    if (!credentials && fallbackProviderId) {
      credentials = await getProviderCredentials(fallbackProviderId, excludeConnectionIds, searchLockKey);
      if (credentials) {
        credentialProviderId = fallbackProviderId;
        log.info("AUTH", `\x1b[32m${providerId} reusing ${fallbackProviderId} credentials\x1b[0m`);
      }
    }

    if (!credentials || credentials.allRateLimited) {
      return accountExhaustedResponse({
        credentials, excludeSize: excludeConnectionIds.size, lastError, lastStatus,
        scope: providerId, provider: providerId,
        noCredentialsMessage: `No credentials for provider: ${providerId}`,
        log, label: "SEARCH", logNoCredentials: true,
      });
    }

    log.info("AUTH", `\x1b[32mUsing ${providerId} account: ${credentials.connectionName}\x1b[0m`);

    const refreshedCredentials = await checkAndRefreshToken(providerId, credentials);

    const result = await handleSearchCore({
      body: coreBody,
      provider: resolvedProvider,
      providerConfig,
      credentials: refreshedCredentials,
      log,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          accessToken: newCreds.accessToken,
          refreshToken: newCreds.refreshToken,
          providerSpecificData: newCreds.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials);
      }
    });

    if (result.success) {
      recordSearchUsage(providerConfig, credentials.connectionId);
      return result.response;
    }

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, credentialProviderId, searchLockKey);

    if (shouldFallback) {
      log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${result.status}), trying fallback`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      attemptLimiter.recordFailure();
      if (attemptLimiter.exceeded) {
        log.warn("SEARCH", `Attempt cap reached (${attemptLimiter.failures} failed accounts), returning last error`);
      } else {
        continue;
      }
    }

    return result.response;
  }
}
