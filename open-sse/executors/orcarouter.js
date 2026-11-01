import { DefaultExecutor } from "./default.js";

// Parse an OpenAI-style Retry-After / rate-limit reset header set into a
// relative delay in milliseconds. Return null when absent or unparsable so
// callers fall back to the default cooldown path. Reads the same header
// family as antigravity.js's parseRetryHeaders (kept local here rather than
// extracted — antigravity's copy stays untouched).
function parseRetryAfter(headers) {
  if (!headers?.get) return null;

  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds) && seconds > 0) return seconds * 1000;

    const date = new Date(retryAfter);
    if (!isNaN(date.getTime())) {
      const diff = date.getTime() - Date.now();
      return diff > 0 ? diff : null;
    }
  }

  const resetAfter = headers.get("x-ratelimit-reset-after");
  if (resetAfter) {
    const seconds = parseInt(resetAfter, 10);
    if (!isNaN(seconds) && seconds > 0) return seconds * 1000;
  }

  const resetTimestamp = headers.get("x-ratelimit-reset");
  if (resetTimestamp) {
    const ts = parseInt(resetTimestamp, 10) * 1000;
    const diff = ts - Date.now();
    return diff > 0 ? diff : null;
  }

  return null;
}

/**
 * OrcaRouterExecutor — OpenAI-compatible gateway (https://api.orcarouter.ai/v1).
 *
 * Everything except error parsing is inherited from DefaultExecutor (Bearer
 * auth, proxy, request translation). OrcaRouter rate limits are per-workspace
 * "bucket" and a 429 carries a Retry-After header (seconds or HTTP-date).
 * Surface that as a precise resetsAtMs so markAccountUnavailable applies an
 * exact cooldown instead of the default guess. Fail-open: any parse problem
 * falls through to the default parseError.
 */
export class OrcaRouterExecutor extends DefaultExecutor {
  constructor() {
    super("orcarouter");
  }

  parseError(response, bodyText) {
    if (response.status === 429) {
      const delayMs = parseRetryAfter(response.headers);
      if (delayMs != null) {
        return {
          status: 429,
          message: bodyText || "Rate limited by OrcaRouter",
          resetsAtMs: Date.now() + delayMs,
        };
      }
    }
    return super.parseError(response, bodyText);
  }
}

export default OrcaRouterExecutor;