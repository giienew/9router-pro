import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";

// Smart member failover (9Router Pro): inside a combo, one member's lane
// must not grind its whole account pool while the client waits. After this
// many failed accounts for the same member in one request, the member gives
// up and the combo moves to its next member at once.
//
// Configured via the `comboMemberAttemptCap` setting. Default 3, clamped to
// 1..10. An explicit 0 disables the cap (the old exhaustive behaviour).
export const DEFAULT_COMBO_MEMBER_ATTEMPT_CAP = 3;
const MAX_COMBO_MEMBER_ATTEMPT_CAP = 10;

// Parse one cap value with the shared rules: 0 disables (null), a
// finite number clamps to 1..10, anything else is "no value" (undefined).
function parseCapValue(v) {
  if (typeof v === "string") v = v.trim() === "" ? undefined : Number(v);
  if (v === 0) return null;
  if (!Number.isFinite(v)) return undefined;
  return Math.min(MAX_COMBO_MEMBER_ATTEMPT_CAP, Math.max(1, Math.floor(v)));
}

// Per-provider (and per-model) override (P3-30), stored in settings as
// `comboMemberAttemptCapOverrides`: { [providerId]: cap, ["provider/model"]: cap }.
// Resolution order: exact per-model key > per-provider key > global
// setting > default. A per-key 0 disables the cap for that provider/model
// even when a global cap exists; an unparseable override value falls
// through to the global setting instead of silently disabling anything.
// Callers that pass no provider/model get exactly the old global behaviour.
export function resolveComboMemberAttemptCap(settings, provider = null, model = null) {
  const overrides = settings?.comboMemberAttemptCapOverrides;
  if (overrides && typeof overrides === "object" && provider) {
    if (model) {
      const perModel = parseCapValue(overrides[`${provider}/${model}`]);
      if (perModel !== undefined) return perModel;
    }
    const perProvider = parseCapValue(overrides[provider]);
    if (perProvider !== undefined) return perProvider;
  }
  const global = parseCapValue(settings?.comboMemberAttemptCap);
  return global === undefined ? DEFAULT_COMBO_MEMBER_ATTEMPT_CAP : global;
}

// Shared account-attempt limiter for the modality fallback loops
// (embeddings, fetch, search, tts, stt, image, video, systemone): the same
// cap chat uses, so a campaign-wide failure stops after `cap` failed
// accounts instead of grinding the whole pool. A null cap disables it
// (the old exhaustive behaviour). Only failed accounts count — skipped
// accounts (e.g. image adapters skipping unentitled plans) do not.
// Shared "no account left" response for the modality fallback loops
// (embeddings, fetch, search, tts, stt, image, video, systemone). Every
// loop used to spell out the same three branches: all-rate-limited →
// unavailableResponse with the last error, first-attempt no credentials →
// 400, pool exhausted → last error or "All accounts unavailable".
// `scope` is the label inside brackets (e.g. "provider/model" for most
// handlers, a bare provider id for search/fetch). `logNoCredentials`
// preserves the handlers that logged the no-credentials case as an error
// (embeddings, fetch, search, systemone); the others never logged it.
export function accountExhaustedResponse({
  credentials,
  excludeSize,
  lastError,
  lastStatus,
  scope,
  provider,
  noCredentialsMessage,
  log,
  label,
  logNoCredentials = false,
}) {
  if (credentials?.allRateLimited) {
    const errorMsg = lastError || credentials.lastError || "Unavailable";
    const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
    log?.warn?.(label, `[${scope}] ${errorMsg} (${credentials.retryAfterHuman})`);
    return unavailableResponse(status, `[${scope}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
  }
  if (excludeSize === 0) {
    if (logNoCredentials) log?.error?.("AUTH", noCredentialsMessage);
    return errorResponse(HTTP_STATUS.BAD_REQUEST, noCredentialsMessage);
  }
  log?.warn?.(label, "No more accounts available", { provider });
  return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
}

export function createAttemptLimiter(cap) {
  let failures = 0;
  return {
    get failures() { return failures; },
    recordFailure() { failures++; },
    get exceeded() { return cap !== null && cap !== undefined && failures >= cap; },
  };
}
