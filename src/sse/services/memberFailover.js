// Smart member failover (9Router Pro): inside a combo, one member's lane
// must not grind its whole account pool while the client waits. After this
// many failed accounts for the same member in one request, the member gives
// up and the combo moves to its next member at once.
//
// Configured via the `comboMemberAttemptCap` setting. Default 3, clamped to
// 1..10. An explicit 0 disables the cap (the old exhaustive behaviour).
export const DEFAULT_COMBO_MEMBER_ATTEMPT_CAP = 3;
const MAX_COMBO_MEMBER_ATTEMPT_CAP = 10;

export function resolveComboMemberAttemptCap(settings) {
  let v = settings?.comboMemberAttemptCap;
  if (typeof v === "string") v = v.trim() === "" ? undefined : Number(v);
  if (v === 0) return null;
  if (!Number.isFinite(v)) return DEFAULT_COMBO_MEMBER_ATTEMPT_CAP;
  return Math.min(MAX_COMBO_MEMBER_ATTEMPT_CAP, Math.max(1, Math.floor(v)));
}

// Shared account-attempt limiter for the modality fallback loops
// (embeddings, fetch, search, tts, stt, image, video, systemone): the same
// cap chat uses, so a campaign-wide failure stops after `cap` failed
// accounts instead of grinding the whole pool. A null cap disables it
// (the old exhaustive behaviour). Only failed accounts count — skipped
// accounts (e.g. image adapters skipping unentitled plans) do not.
export function createAttemptLimiter(cap) {
  let failures = 0;
  return {
    get failures() { return failures; },
    recordFailure() { failures++; },
    get exceeded() { return cap !== null && cap !== undefined && failures >= cap; },
  };
}
