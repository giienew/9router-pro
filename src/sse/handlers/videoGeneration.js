import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { resolveComboMemberAttemptCap, createAttemptLimiter, accountExhaustedResponse } from "../services/memberFailover.js";
import { getSettings, getProviderConnectionById } from "@/lib/localDb";
import { getModelInfo } from "../services/model.js";
import { getKeyAccessContext, enforceKeyAccessResolved } from "../services/keyAccess.js";
import { handleVideoProxyCore, getVideoConfig, sanitizeSecrets } from "open-sse/handlers/videoCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";

const NO_AUTH_VIDEO_PROVIDERS = new Set(["veoaifree-web"]);
import * as log from "../utils/logger.js";
import { withKeyAdmission } from "../services/keyAdmission.js";
import { requestIdFromRequest, attachRequestId } from "../utils/requestId.js";
import { recordModalityUsage } from "../services/modalityUsage.js";

// Video generation is xAI-only today; requests without a provider prefix
// (bare model id, or multipart bodies we deliberately don't parse) land here.
const DEFAULT_VIDEO_PROVIDER = "xai";

/**
 * Poll requests carry no model, so the provider comes from the pinned
 * connection (`x-connection-id`, returned on create) or an explicit
 * `?provider=` — falling back to the historical xAI default.
 */
async function resolveGetProvider(request, connectionId) {
  if (connectionId) {
    const conn = await getProviderConnectionById(connectionId).catch(() => null);
    if (conn?.provider && getVideoConfig(conn.provider)) return conn.provider;
  }
  const queried = new URL(request.url).searchParams.get("provider");
  if (queried && getVideoConfig(queried)) return queried;
  return DEFAULT_VIDEO_PROVIDER;
}

// Creation POSTs are billable jobs — only rotate to another account for
// errors that upstream rejects BEFORE creating a job (auth/quota). A 5xx may
// have created the job, so it is returned to the caller instead of re-sent.
const CREATE_ROTATION_STATUSES = new Set([
  HTTP_STATUS.UNAUTHORIZED,
  HTTP_STATUS.FORBIDDEN,
  HTTP_STATUS.RATE_LIMITED,
]);

async function requireValidApiKey(request) {
  const apiKey = extractApiKey(request);
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }
  return null;
}

/**
 * Read the request body once, byte-preserving.
 * JSON bodies are additionally parsed so the `model` provider prefix can be
 * resolved (and stripped) — everything else is forwarded exactly as received.
 */
async function readForwardableBody(request) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const raw = await request.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body") };
    }
    return { raw, parsed, contentType };
  }
  // Multipart (or any other content type): forward the exact bytes — parsing
  // and re-encoding FormData would change the multipart boundary.
  const buf = Buffer.from(await request.arrayBuffer());
  return { raw: buf, parsed: null, contentType };
}

async function resolveVideoProvider(parsedBody) {
  if (!parsedBody?.model) return { provider: DEFAULT_VIDEO_PROVIDER, model: null };

  const modelStr = String(parsedBody.model);
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) {
    return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Combos are not supported for video generation") };
  }
  if (!getVideoConfig(modelInfo.provider)) {
    // Bare model ids (no explicit "provider/" prefix) fall back to the default
    // video provider — the prefix-less inference targets chat providers only.
    if (!modelStr.includes("/")) {
      return { provider: DEFAULT_VIDEO_PROVIDER, model: modelStr };
    }
    return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, `Provider '${modelInfo.provider}' does not support video generation`) };
  }
  return { provider: modelInfo.provider, model: modelInfo.model };
}

function withConnectionHeader(response, connectionId) {
  if (!connectionId) return response;
  const headers = new Headers(response.headers);
  // Video jobs are account-bound upstream — clients echo this back as
  // `x-connection-id` on GET polls so the same account is used.
  headers.set("x-9router-connection-id", String(connectionId));
  return new Response(response.body, { status: response.status, headers });
}

/**
 * POST /v1/videos/{generations|edits|extensions} — async job creation proxy.
 */
export async function handleVideoCreate(request, action) {
  const requestId = requestIdFromRequest(request);
  const response = await withKeyAdmission(request, () => handleVideoCreateImpl(request, action, requestId));
  return attachRequestId(response, requestId);
}

// G9: video creation only ACCEPTS an async job — the provider bills on
// completion, and the poll path surfaces no usage payload, so no token or
// USD figure exists to accrue at creation time. Creation records a
// request-only row (visible in usage history, moves no quota). That is an
// explicit disclosed gap, not a silent omission: token/cost quotas do not
// count video spend until a provider reports it.
async function handleVideoCreateImpl(request, action, requestId = null) {
  const apiKey = extractApiKey(request);
  const endpoint = new URL(request.url).pathname;
  const recordVideoAcceptance = (connectionId, provider, model) => {
    recordModalityUsage({
      provider, model: model || "video", connectionId, apiKey, endpoint, requestId,
      meta: { accrual: "request-only", reason: "async job billed on completion; no usage reported at acceptance" },
    });
  };
  const authError = await requireValidApiKey(request);
  if (authError) return authError;

  const bodyInfo = await readForwardableBody(request);
  if (bodyInfo.error) return bodyInfo.error;

  const resolved = await resolveVideoProvider(bodyInfo.parsed);
  if (resolved.error) return resolved.error;
  const { provider, model } = resolved;

  // Per-key access control: the routed provider/model must be listed. A body
  // we cannot read a model from (multipart) is denied for restricted keys.
  const keyAccessDenied = await enforceKeyAccessResolved(
    await getKeyAccessContext(request), bodyInfo.parsed?.model ? String(bodyInfo.parsed.model) : "", provider, model
  );
  if (keyAccessDenied) return keyAccessDenied;

  // Strip the provider prefix (e.g. "xai/grok-imagine-video") before forwarding;
  // otherwise forward the original bytes untouched.
  let forwardBody = bodyInfo.raw;
  if (bodyInfo.parsed && model && bodyInfo.parsed.model !== model) {
    forwardBody = JSON.stringify({ ...bodyInfo.parsed, model });
  }

  const preferredConnectionId = request.headers.get("x-connection-id") || null;
  const idempotencyKey = request.headers.get("idempotency-key") || null;

  // noAuth providers — executor-driven generation, no credential needed
  if (NO_AUTH_VIDEO_PROVIDERS.has(provider)) {
    const result = await handleVideoProxyCore({
      provider,
      action,
      rawBody: forwardBody,
      contentType: bodyInfo.contentType || null,
      idempotencyKey: null,
      credentials: null,
      signal: request.signal,
      log,
    });
    if (result.success) {
      recordVideoAcceptance(null, provider, model);
      return result.response;
    }
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "Video generation failed");
  }

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
        scope: `${provider}/${model || "video"}`, provider,
        noCredentialsMessage: `No credentials for provider: ${provider}`,
      });
    }

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    const result = await handleVideoProxyCore({
      provider,
      action,
      rawBody: forwardBody,
      contentType: bodyInfo.contentType || null,
      idempotencyKey,
      credentials: refreshedCredentials,
      signal: request.signal,
      log,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          accessToken: newCreds.accessToken,
          refreshToken: newCreds.refreshToken,
          // Executor-driven web providers rotate their cookie credential in place.
          apiKey: newCreds.apiKey,
          providerSpecificData: newCreds.providerSpecificData,
          testStatus: "active",
        });
      },
    });

    if (result.success) {
      await clearAccountError(credentials.connectionId, credentials, model);
      recordVideoAcceptance(credentials.connectionId, provider, model);
      log.info("VIDEO", `${provider.toUpperCase()} | ${action} accepted (connection ${credentials.connectionId})`);
      return withConnectionHeader(result.response, credentials.connectionId);
    }

    // Record the failure (dashboard shows lastError/errorCode → user sees re-auth is needed)
    const { shouldFallback } = await markAccountUnavailable(
      credentials.connectionId, result.status, sanitizeSecrets(result.error, refreshedCredentials), provider, model
    );

    if (shouldFallback && CREATE_ROTATION_STATUSES.has(result.status)) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      attemptLimiter.recordFailure();
      if (attemptLimiter.exceeded) {
        log.warn("VIDEO", `Attempt cap reached (${attemptLimiter.failures} failed accounts), returning last error`);
      } else {
        continue;
      }
    }

    return result.response;
  }
}

/**
 * GET /v1/videos/{request_id} — poll job status.
 * Jobs are account-bound upstream, so no cross-account rotation here: the
 * caller pins the creating account via `x-connection-id` (returned on create).
 */
export async function handleVideoGet(request, requestId) {
  const authError = await requireValidApiKey(request);
  if (authError) return authError;

  if (!requestId) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing video request id");

  const preferredConnectionId = request.headers.get("x-connection-id") || null;
  const provider = await resolveGetProvider(request, preferredConnectionId);

  const credentials = await getProviderCredentials(provider, null, null, { preferredConnectionId });
  if (!credentials || credentials.allRateLimited) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
  }

  const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

  const result = await handleVideoProxyCore({
    provider,
    requestId,
    credentials: refreshedCredentials,
    signal: request.signal,
    log,
    onCredentialsRefreshed: async (newCreds) => {
      await updateProviderCredentials(credentials.connectionId, {
        accessToken: newCreds.accessToken,
        refreshToken: newCreds.refreshToken,
        providerSpecificData: newCreds.providerSpecificData,
        testStatus: "active",
      });
    },
  });

  if (result.success) {
    await clearAccountError(credentials.connectionId, credentials, null);
    return withConnectionHeader(result.response, credentials.connectionId);
  }

  await markAccountUnavailable(
    credentials.connectionId, result.status, sanitizeSecrets(result.error, refreshedCredentials), provider, null
  );
  return result.response;
}
