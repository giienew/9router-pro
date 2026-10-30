// Non-chat usage accrual (G9): one shared writer so every modality
// records spend the same way chat does (saveRequestUsage → usageHistory,
// daily rollups, lifetime counter), and so key quotas count it.
//
// Accrual basis differs by modality because providers report different
// spend, and the row's `meta.accrual` says which basis was used —
// never silently pretending an estimate is a provider report:
//   * "reported" — provider-returned token counts (embeddings, image,
//     systemone, chat).
//   * "estimated" — no provider count exists, so tokens are estimated
//     from text length at the codebase's own chars/4 convention (TTS
//     input, STT transcript). Quota sums move; the estimate is visible.
//   * "cost-only" — spend is USD-per-call, not tokens (web search/fetch
//     costPerQuery). Token quotas do not move, but cost quotas do via
//     costOverride, and the request is visible in usage history.
//   * "request-only" — neither tokens nor a USD cost are available
//     (image with no reported usage on a streaming response, async
//     video jobs billed on completion). The request is recorded so it
//     is visible, but it moves no quota — that gap is disclosed here
//     and in the handler comments, not hidden.
import { saveRequestUsage } from "@/lib/usageDb.js";

// The codebase's own token-estimation convention (see TokenSaverPro:
// "÷4 chars/token"). Used only where a provider reports no usage at all.
export function estimateTokensFromText(text) {
  const len = typeof text === "string" ? text.length : 0;
  return Math.ceil(len / 4);
}

export function recordModalityUsage({
  provider,
  model,
  connectionId,
  apiKey,
  endpoint,
  requestId,
  tokens,
  costOverride,
  meta,
}) {
  saveRequestUsage({
    provider,
    model,
    connectionId: connectionId || undefined,
    apiKey,
    endpoint: endpoint || null,
    tokens: tokens || { prompt_tokens: 0, completion_tokens: 0 },
    status: "success",
    requestId: requestId || undefined,
    ...(Number.isFinite(costOverride) ? { costOverride } : {}),
    ...(meta ? { meta } : {}),
  }).catch(() => {});
}
