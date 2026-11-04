// Shared classification for provider + model test results.
//
// One vocabulary everywhere, so a red X never again hides the real cause.
// A test result carries { ok/valid, stage, status, error } and the UI shows
// the stage label next to the message, instead of collapsing every failure
// into one generic "error".
//
// Stages:
//   ok         - test passed
//   auth       - key/session rejected (401/403, invalid key)
//   model      - model or request rejected (400/404, model not found)
//   rate_limit - key accepted but throttled / out of credits (402/429)
//   upstream   - provider server error (5xx)
//   network    - could not connect at all (DNS, refused, connect timeout,
//                incl. a failing proxy route)
//   proxy      - the configured proxy itself failed its own check
//   timeout    - the test itself gave up first (ping abort), not proof the
//                provider is dead
//   unknown    - anything else

export const TEST_STAGE_LABELS = {
  ok: "OK",
  auth: "Key rejected (auth)",
  model: "Model or request rejected",
  rate_limit: "Rate limited",
  upstream: "Upstream error",
  network: "Connection failed (network/proxy)",
  proxy: "Proxy failed",
  timeout: "Test timed out",
  unknown: "Test failed",
};

export function getStageLabel(stage) {
  return TEST_STAGE_LABELS[stage] || TEST_STAGE_LABELS.unknown;
}

export function classifyTestError({ status, error } = {}) {
  const code = Number(status);
  if (Number.isFinite(code) && code > 0) {
    if (code === 401 || code === 403) return { stage: "auth" };
    if (code === 404) return { stage: "model" };
    if (code === 400) return { stage: "model" };
    if (code === 402 || code === 429) return { stage: "rate_limit" };
    if (code >= 500 && code <= 599) return { stage: "upstream" };
  }
  const msg = String(error || "").toLowerCase();
  if (!msg) return { stage: "unknown" };
  if (msg.includes("proxy")) return { stage: "proxy" };
  if (
    msg.includes("connect timeout") ||
    msg.includes("connection") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("enotfound") ||
    msg.includes("dns") ||
    msg.includes("fetch failed") ||
    msg.includes("failed to fetch") ||
    msg.includes("network")
  ) {
    return { stage: "network" };
  }
  if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("abort")) {
    return { stage: "timeout" };
  }
  if (
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("unauthorized") ||
    msg.includes("invalid api key") ||
    msg.includes("invalid key")
  ) {
    return { stage: "auth" };
  }
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("rate_limited")) {
    return { stage: "rate_limit" };
  }
  if (msg.includes("404") || msg.includes("not found") || msg.includes("model not")) {
    return { stage: "model" };
  }
  if (msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("upstream") || msg.includes("server error")) {
    return { stage: "upstream" };
  }
  return { stage: "unknown" };
}
