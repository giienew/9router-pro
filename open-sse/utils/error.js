import { ERROR_TYPES, DEFAULT_ERROR_MESSAGES, MAX_RATE_LIMIT_COOLDOWN_MS } from "../config/errorConfig.js";
import { emitErrorWebhook } from "@/lib/webhookEvents.js";

/**
 * Build OpenAI-compatible error response body
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @returns {object} Error response object
 */
export function buildErrorBody(statusCode, message) {
  const errorInfo = ERROR_TYPES[statusCode] || 
    (statusCode >= 500 
      ? { type: "server_error", code: "internal_server_error" }
      : { type: "invalid_request_error", code: "" });

  return {
    error: {
      message: message || DEFAULT_ERROR_MESSAGES[statusCode] || "An error occurred",
      type: errorInfo.type,
      code: errorInfo.code
    }
  };
}

/**
 * Create error Response object (for non-streaming)
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @returns {Response} HTTP Response object
 */
export function errorResponse(statusCode, message, extraHeaders = null) {
  return new Response(JSON.stringify(buildErrorBody(statusCode, message)), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders
    }
  });
}

/**
 * Write error to SSE stream (for streaming)
 * @param {WritableStreamDefaultWriter} writer - Stream writer
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 */
export async function writeStreamError(writer, statusCode, message) {
  const errorBody = buildErrorBody(statusCode, message);
  const encoder = new TextEncoder();
  await writer.write(encoder.encode(`data: ${JSON.stringify(errorBody)}\n\n`));
}

/**
 * Parse an upstream Retry-After value (opt80) into a cooldown in ms.
 * Accepts delay-seconds ("120") or an HTTP-date. Returns null for a
 * missing, unparseable, or already-past value (the caller then falls back
 * to its normal backoff). Capped at MAX_RATE_LIMIT_COOLDOWN_MS, the same
 * cap the codebase already applies to provider-reported resets.
 * @param {string|null|undefined} value
 * @param {number} now - ms epoch, injectable for tests
 * @returns {number|null}
 */
export function parseRetryAfterMs(value, now = Date.now()) {
  if (value == null) return null;
  const str = String(value).trim();
  if (!str) return null;
  const seconds = Number(str);
  if (Number.isFinite(seconds)) {
    if (seconds < 0) return null;
    return Math.min(Math.floor(seconds * 1000), MAX_RATE_LIMIT_COOLDOWN_MS);
  }
  const dateMs = Date.parse(str);
  if (!Number.isFinite(dateMs)) return null;
  const delta = dateMs - now;
  if (delta <= 0) return null;
  return Math.min(delta, MAX_RATE_LIMIT_COOLDOWN_MS);
}

function readRetryAfterMs(response) {
  try {
    const headers = response?.headers;
    if (!headers) return null;
    const raw = typeof headers.get === "function" ? headers.get("retry-after") : headers["retry-after"];
    return parseRetryAfterMs(raw);
  } catch {
    return null;
  }
}

/**
 * Parse upstream provider error response
 * @param {Response} response - Fetch response from provider
 * @param {object} [executor] - Optional executor with parseError() override for provider-specific parsing
 * @returns {Promise<{statusCode: number, message: string, resetsAtMs?: number}>}
 */
export async function parseUpstreamError(response, executor = null) {
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    bodyText = "";
  }

  // Let executor-specific parser extract provider-specific fields (e.g. codex resetsAtMs)
  if (executor && typeof executor.parseError === "function") {
    try {
      const parsed = executor.parseError(response, bodyText);
      if (parsed && typeof parsed === "object") {
        const msg = parsed.message || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;
        // An executor-provided resetsAtMs wins; otherwise the generic
        // Retry-After header fills it (429 only).
        let resetsAtMs = parsed.resetsAtMs;
        if (resetsAtMs == null && response.status === 429) {
          const retryMs = readRetryAfterMs(response);
          if (retryMs != null) resetsAtMs = Date.now() + retryMs;
        }
        return { statusCode: parsed.status || response.status, message: msg, resetsAtMs };
      }
    } catch { /* fall through to default parsing */ }
  }

  let message = "";
  try {
    const json = JSON.parse(bodyText);
    message = json.error?.message || json.message || json.error || bodyText;
  } catch {
    message = bodyText;
  }

  const messageStr = typeof message === "string" ? message : JSON.stringify(message);
  const finalMessage = messageStr || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;

  // Generic Retry-After (opt80): a 429 that carries the header parks the
  // key for exactly that long (capped) instead of the blind backoff.
  // chatCore already forwards resetsAtMs into markAccountUnavailable.
  let resetsAtMs;
  if (response.status === 429) {
    const retryMs = readRetryAfterMs(response);
    if (retryMs != null) resetsAtMs = Date.now() + retryMs;
  }

  return { statusCode: response.status, message: finalMessage, resetsAtMs };
}

/**
 * Create error result for chatCore handler
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {number} [resetsAtMs] - Optional precise cooldown expiry (ms epoch) for provider-specific quota errors
 * @returns {{ success: false, status: number, error: string, response: Response, resetsAtMs?: number }}
 */
export function createErrorResult(statusCode, message, resetsAtMs, extraHeaders = null) {
  // Structured webhook event (P3-30): server/upstream failures only
  // (status >= 500). Client validation errors (4xx) are not events —
  // they would flood a receiver with the caller's own mistakes. Off by
  // default, fire-and-forget, never blocks the error response itself.
  if (Number(statusCode) >= 500) {
    emitErrorWebhook({ status: Number(statusCode), error: String(message || "").slice(0, 500) });
  }
  return {
    success: false,
    status: statusCode,
    error: message,
    resetsAtMs,
    response: errorResponse(statusCode, message, extraHeaders)
  };
}

/**
 * Create unavailable response when all accounts are rate limited
 * @param {number} statusCode - Original error status code
 * @param {string} message - Error message (without retry info)
 * @param {string} retryAfter - ISO timestamp when earliest account becomes available
 * @param {string} retryAfterHuman - Human-readable retry info e.g. "reset after 30s"
 * @returns {Response}
 */
export function unavailableResponse(statusCode, message, retryAfter, retryAfterHuman, extraHeaders = null) {
  const retryAfterSec = Math.max(Math.ceil((new Date(retryAfter).getTime() - Date.now()) / 1000), 1);
  const msg = `${message} (${retryAfterHuman})`;
  return new Response(
    JSON.stringify({ error: { message: msg } }),
    {
      status: statusCode,
      headers: {
        ...extraHeaders,
        "Content-Type": "application/json",
        // Intentionally mis-cased to prevent duplicate headers
        "retry-after": String(retryAfterSec)
      }
    }
  );
}

/**
 * Format provider error with context
 * @param {Error} error - Original error
 * @param {string} provider - Provider name
 * @param {string} model - Model name
 * @param {number|string} statusCode - HTTP status code or error code
 * @returns {string} Formatted error message
 */
export function formatProviderError(error, provider, model, statusCode) {
  const code = statusCode || error.code || "FETCH_FAILED";
  const message = error.message || "Unknown error";
  // Expose low-level cause (e.g. UND_ERR_SOCKET, ECONNRESET, ETIMEDOUT) for diagnosing fetch failures
  const causeCode = error.cause?.code;
  const causeMsg = error.cause?.message;
  const causeStr = causeCode || causeMsg ? ` (cause: ${[causeCode, causeMsg].filter(Boolean).join(": ")})` : "";
  return `[${code}]: ${message}${causeStr}`;
}
