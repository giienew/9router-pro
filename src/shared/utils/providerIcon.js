// Provider icon paths under /public/providers.
// Alias related brands; session-cache 404s so one miss never spams again.

const ICON_ALIASES = {
  "perplexity-agent": "perplexity",
  "gitlab-duo": "gitlab",
  "vercel-ai-gateway": "vercel",
  "ollama-search": "ollama",
  // MiniMax Code rides the existing MiniMax brand mark
  "minimax-code": "minimax",
  "minimax-code-global": "minimax",
  // Zen is the same opencode.ai brand
  "opencode-zen": "opencode",
  "opencode-v2": "opencode",
  // Web-cookie variants ride their brand's existing mark
  "deepseek-web": "deepseek",
  "muse-web": "muse",
  "gemini-web": "gemini",
  "chatgpt-web": "openai",
};

// Runtime only — first 404 remembers id for the whole session
const failedIds = new Set();

function normalizeId(providerId) {
  if (!providerId || typeof providerId !== "string") return "";
  return providerId.trim().toLowerCase();
}

/** Resolve icon file id (after alias). Empty if previously failed this session. */
export function resolveProviderIconId(providerId) {
  const id = normalizeId(providerId);
  if (!id) return "";
  if (failedIds.has(id)) return "";
  const aliased = ICON_ALIASES[id] || id;
  if (failedIds.has(aliased)) return "";
  return aliased;
}

/** `/providers/{id}.png` or null when previously failed. */
export function getProviderIconSrc(providerId) {
  const id = resolveProviderIconId(providerId);
  return id ? `/providers/${id}.png` : null;
}

// Favicon auto-detection for custom providers (9Router Pro): candidate
// icon URLs derived from a provider's API base URL — the origin first,
// then the parent domain (e.g. api.gonka-api.org serves no icon while
// gonka-api.org does). Local and IP hosts get no candidates. Misses are
// session-cached so a dead candidate is never requested twice.
const failedFavicons = new Set();

export function getFaviconCandidates(baseUrl) {
  if (!baseUrl || typeof baseUrl !== "string") return [];
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return [];
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return [];
  const host = url.hostname;
  if (!host || host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return [];
  const out = [];
  const originIcon = `${url.protocol}//${host}/favicon.ico`;
  if (!failedFavicons.has(originIcon)) out.push(originIcon);
  const labels = host.split(".");
  if (labels.length > 2) {
    const parentIcon = `${url.protocol}//${labels.slice(1).join(".")}/favicon.ico`;
    if (parentIcon !== originIcon && !failedFavicons.has(parentIcon)) out.push(parentIcon);
  }
  return out;
}

/** Call from img onError so later mounts skip the candidate. */
export function markFaviconMissing(iconUrl) {
  if (iconUrl) failedFavicons.add(iconUrl);
}

/** Call from img onError so later mounts skip the request. */
export function markProviderIconMissing(providerId) {
  const id = normalizeId(providerId);
  if (id) failedIds.add(id);
  const aliased = ICON_ALIASES[id];
  if (aliased) failedIds.add(aliased);
}
