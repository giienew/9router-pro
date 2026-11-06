// Parse the precise quota-reset time from an OpenCode free-tier 429.
// Upstream reports the reset three ways, in priority order:
//   1. error.resets_at — unix seconds, only when it lies in the future
//   2. error.resets_in_seconds — seconds from now
//   3. the retry-after response header — delta seconds, or an HTTP-date
// A 429 with none of these is a gate refusal, not a quota window, so this
// returns null and the caller falls back to the default error parse.
// The reset is returned raw; the cooldown cap (C-5 max vs blind backoff,
// MAX_RATE_LIMIT_COOLDOWN_MS) is applied downstream in markAccountUnavailable.
export function parseOpencodeRateLimitReset(response, bodyText) {
  if (!response || response.status !== 429) return null;
  const now = Date.now();
  let resetsAtMs = null;
  let message = null;
  if (bodyText) {
    try {
      const json = JSON.parse(bodyText);
      const err = json?.error;
      if (typeof err?.resets_at === "number" && err.resets_at > 0) {
        const ms = err.resets_at * 1000;
        if (ms > now) resetsAtMs = ms;
      }
      if (!resetsAtMs && typeof err?.resets_in_seconds === "number" && err.resets_in_seconds > 0) {
        resetsAtMs = now + err.resets_in_seconds * 1000;
      }
      if (typeof err?.message === "string" && err.message) message = err.message;
    } catch { /* body is not JSON — the retry-after header may still carry the reset */ }
  }
  if (!resetsAtMs) {
    const retryAfter = response.headers?.get?.("retry-after");
    if (typeof retryAfter === "string") {
      const trimmed = retryAfter.trim();
      if (trimmed) {
        const seconds = Number(trimmed);
        if (Number.isFinite(seconds) && seconds > 0) {
          resetsAtMs = now + Math.floor(seconds) * 1000;
        } else {
          const dateMs = Date.parse(trimmed);
          if (Number.isFinite(dateMs) && dateMs > now) resetsAtMs = dateMs;
        }
      }
    }
  }
  if (!resetsAtMs) return null;
  return { resetsAtMs, message: message || bodyText };
}
