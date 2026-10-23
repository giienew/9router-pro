import { getProxyPoolById, getProxyPools } from "@/models";

// Safely normalize any value into a trimmed string.
function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

// ─── Proxy pool rotation state (in-memory) ─────────────────────────
const rotateState = new Map(); // providerId → { index }

/**
 * Pick one proxy pool ID from a list based on strategy.
 * round-robin: cycle sequentially (in-memory, resets on restart)
 * random:      uniform random pick
 * none/single: return first entry
 */
export function pickProxyPoolId(poolIds, strategy, providerId) {
  if (!poolIds || poolIds.length === 0) return null;
  if (poolIds.length === 1) return poolIds[0];

  if (strategy === "round-robin") {
    const state = rotateState.get(providerId) || { index: -1 };
    state.index = (state.index + 1) % poolIds.length;
    rotateState.set(providerId, state);
    return poolIds[state.index];
  }

  if (strategy === "random") {
    return poolIds[Math.floor(Math.random() * poolIds.length)];
  }

  return poolIds[0]; // "none" or unknown
}

/**
 * Resolve which pool IDs a rotation runs over. A saved selection
 * (providerStrategies proxyPoolIds) restricts rotation to those pools;
 * an empty or absent selection keeps the legacy behavior of rotating
 * across every usable active pool.
 */
export function resolveRotationPoolIds(allPools, selectedIds) {
  const usable = (allPools || []).filter((p) => p && p.id && p.proxyUrl).map((p) => p.id);
  if (!Array.isArray(selectedIds) || selectedIds.length === 0) return usable;
  const wanted = new Set(selectedIds);
  return usable.filter((id) => wanted.has(id));
}

/**
 * Normalize legacy proxy configuration.
 */
function normalizeLegacyProxy(providerSpecificData = {}) {
  const connectionProxyEnabled =
    providerSpecificData?.connectionProxyEnabled === true;

  const connectionProxyUrl = normalizeString(
    providerSpecificData?.connectionProxyUrl
  );

  const connectionNoProxy = normalizeString(
    providerSpecificData?.connectionNoProxy
  );

  return {
    connectionProxyEnabled,
    connectionProxyUrl,
    connectionNoProxy,
  };
}

/**
 * Resolve final proxy configuration.
 *
 * Priority:
 * 1. Proxy Pool
 * 2. Legacy Proxy
 * 3. No Proxy
 */
export async function resolveConnectionProxyConfig(
  providerSpecificData = {}
) {
  try {
    const proxyPoolIdRaw = normalizeString(
      providerSpecificData?.proxyPoolId
    );

    // "__none__" means explicitly disabled
    const proxyPoolId =
      proxyPoolIdRaw === "__none__" ? "" : proxyPoolIdRaw;

    const legacy = normalizeLegacyProxy(providerSpecificData);

    // A strict pool must keep its guarantee even when the pool itself is not
    // usable (inactive, or saved without a url). Otherwise the unusable-pool
    // path below reports strictProxy:false and the request silently leaves
    // over the direct IP — the leak strict mode exists to prevent (#4333).
    let poolStrictProxy = false;

    /**
     * -----------------------------
     * Proxy Pool Resolution
     * -----------------------------
     */
    if (proxyPoolId) {
      const proxyPool = await getProxyPoolById(proxyPoolId);

      const proxyUrl = normalizeString(proxyPool?.proxyUrl);
      const noProxy = normalizeString(proxyPool?.noProxy);

      const isValidPool =
        proxyPool &&
        proxyPool.isActive === true &&
        proxyUrl;

      poolStrictProxy = proxyPool?.strictProxy === true;

      if (isValidPool) {
        /**
         * Vercel/Cloudflare/Deno/Netlify relay proxies use base URL rewriting
         * instead of HTTP_PROXY environment variables.
         */
        if (proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno" || proxyPool.type === "netlify") {
          return {
            source: proxyPool.type,

            proxyPoolId,
            proxyPool,

            connectionProxyEnabled: false,
            connectionProxyUrl: "",
            connectionNoProxy: noProxy,

            strictProxy: proxyPool.strictProxy === true,

            vercelRelayUrl: proxyUrl, // Still mapped to vercelRelayUrl in the unified payload since they use the exact same header spec
          };
        }

        /**
         * Standard proxy pool
         */
        return {
          source: "pool",

          proxyPoolId,
          proxyPool,

          connectionProxyEnabled: true,
          connectionProxyUrl: proxyUrl,
          connectionNoProxy: noProxy,

          strictProxy: proxyPool.strictProxy === true,
        };
      }
    }

    /**
     * -----------------------------
     * Legacy Proxy Fallback
     * -----------------------------
     */
    if (
      legacy.connectionProxyEnabled &&
      legacy.connectionProxyUrl
    ) {
      return {
        source: "legacy",

        proxyPoolId: proxyPoolId || null,
        proxyPool: null,

        strictProxy: poolStrictProxy,

        ...legacy,
      };
    }

    /**
     * -----------------------------
     * No Proxy Config
     * -----------------------------
     */
    return {
      source: "none",

      proxyPoolId: proxyPoolId || null,
      proxyPool: null,

      strictProxy: poolStrictProxy,

      ...legacy,
    };
  } catch (error) {
    console.error(
      "[resolveConnectionProxyConfig] Failed to resolve proxy config:",
      error
    );

    return {
      source: "error",

      proxyPoolId: null,
      proxyPool: null,

      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",

      strictProxy: false,
    };
  }
}

/**
 * Auto proxy for connection TESTS (9Router Pro): when a connection has
 * no proxy of its own, a test may borrow one from the active standard
 * pools (round-robin) so the test reflects proxied reality instead of
 * the server's direct IP. Best-effort only — callers fall back to a
 * direct test when the borrowed proxy fails its pre-check. Relay pools
 * (vercel/cloudflare/deno/netlify) are never borrowed. Returns a config
 * in the same shape as resolveConnectionProxyConfig, or null.
 */
export async function resolveAutoTestProxy() {
  try {
    const pools = await getProxyPools({ isActive: true });
    const RELAY_TYPES = ["vercel", "cloudflare", "deno", "netlify"];
    const standard = (pools || []).filter(
      (p) => p && normalizeString(p.proxyUrl) && !RELAY_TYPES.includes(p.type)
    );
    if (!standard.length) return null;
    const pickedId = pickProxyPoolId(standard.map((p) => p.id), "round-robin", "__autotest__");
    const pool = standard.find((p) => p.id === pickedId) || standard[0];
    return {
      source: "auto-pool",
      proxyPoolId: pool.id,
      proxyPool: pool,
      connectionProxyEnabled: true,
      connectionProxyUrl: normalizeString(pool.proxyUrl),
      connectionNoProxy: normalizeString(pool.noProxy),
      strictProxy: false,
      autoProxy: true,
    };
  } catch {
    return null;
  }
}
