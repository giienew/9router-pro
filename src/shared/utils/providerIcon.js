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
  // Custom provider node ids (e.g. openai-compatible-chat-<uuid>) never
  // have a bundled icon — skip the /providers/*.png request entirely
  // instead of firing a 404 on first render each session. The favicon /
  // initials chain still applies.
  if (/-compatible-chat-/.test(id)) return "";
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

// Brand-by-host allowlist for custom providers: a custom node id
// (e.g. openai-compatible-chat-<uuid>) never matches a bundled icon,
// but when its API base URL is a known brand host, the brand's bundled
// 128px mark is the crisp candidate — far sharper than the 16px
// favicon.ico the auto-detection path used to serve first. Both files
// exist under /public/providers; a missing brand falls through to the
// favicon chain, and a 404 is session-cached like every other miss.
const HOST_TO_BRAND = {
  "api.openai.com": "openai",
  "openai.com": "openai",
  "api.anthropic.com": "anthropic",
  "anthropic.com": "anthropic",
};

/** `/providers/{brand}.png` for a known brand host, else null. */
export function getBrandIconSrc(baseUrl) {
  if (!baseUrl || typeof baseUrl !== "string") return null;
  let host;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  const brand = HOST_TO_BRAND[host];
  if (!brand || failedIds.has(brand)) return null;
  return `/providers/${brand}.png`;
}

/** `/providers/{name}.png` for a provider display name, else null.
 *  Normalization strips everything but [a-z0-9], so "Token Harbor"
 *  resolves to the tokenharbor mark. A missing file just 404s and the
 *  chain falls through; the miss is session-cached like every other. */
export function getNameIconSrc(alt) {
  if (!alt || typeof alt !== "string") return null;
  const name = alt.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!name || failedIds.has(name)) return null;
  return `/providers/${name}.png`;
}

// Favicon auto-detection for custom providers (9Router Pro): candidate
// icon URLs derived from a provider's API base URL — the high-res
// apple-touch-icon first, then favicon.ico; origin first, then the
// parent domain (e.g. api.gonka-api.org serves no icon while
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
  const push = (candidate) => {
    if (!failedFavicons.has(candidate) && !out.includes(candidate)) out.push(candidate);
  };
  const labels = host.split(".");
  const parent = labels.length > 2 ? labels.slice(1).join(".") : null;
  push(`${url.protocol}//${host}/apple-touch-icon.png`);
  if (parent) push(`${url.protocol}//${parent}/apple-touch-icon.png`);
  push(`${url.protocol}//${host}/favicon.ico`);
  if (parent) push(`${url.protocol}//${parent}/favicon.ico`);
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
