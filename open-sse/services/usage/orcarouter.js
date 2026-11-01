/**
 * OrcaRouter usage.
 *
 * OrcaRouter is NOT a NewAPI gateway and exposes no account-balance endpoint:
 * there is no credits/remaining-$ query, only per-request cost. Return an
 * honest message so the quota dashboard never shows a misleading number.
 */

/**
 * @param {string|null|undefined} [apiKey]
 * @param {object|null} [proxyOptions]
 */
export async function getOrcarouterUsage(apiKey = null, proxyOptions = null) {
  return {
    plan: "OrcaRouter",
    message:
      "OrcaRouter does not expose an account balance API. Balance is tracked per-request via cost headers (X-OrcaRouter-Include-Cost / GET /v1/generation?id=…); no credits or remaining-$ query is available.",
  };
}