import { getApiKeyByKey, getInjectKeyModelPrompts, getInjectModelPrompts } from "@/lib/localDb";

/**
 * Resolve a combo's effective strategy (9Router Pro pair rotation).
 *
 * Precedence: the combo's own configured strategy, then the global
 * combo strategy, then "auto". "auto" is the untouched default: a pair
 * — a name carrying its own prompt injection (set on the Prompt
 * Injection page, for all keys or for the calling key) backed by more
 * than one model — rotates its starting model per request
 * ("round-robin", sticky 1) so the load spreads across the backing
 * providers instead of the first model serving until it fails; a
 * failure still falls through the remaining models in order.
 * Everything else falls back sequentially. Storage errors fail open
 * to "fallback".
 *
 * An explicit global "fallback" means fallback everywhere, including
 * pairs — that was the surprise: the old default materialized
 * "fallback" for users who never chose anything, so the global value
 * only counted when it was not "fallback" and an explicit fallback
 * could not pin pairs. A per-combo "fallback" still pins one pair.
 */
export async function resolveComboStrategy(modelStr, comboModels, settings, apiKey) {
  const comboStrategies = settings?.comboStrategies || {};
  const specific = comboStrategies[modelStr]?.fallbackStrategy;
  if (specific && specific !== "auto") return specific;
  if (settings?.comboStrategy && settings.comboStrategy !== "auto") return settings.comboStrategy;

  if (Array.isArray(comboModels) && comboModels.length > 1) {
    try {
      const modelPrompts = await getInjectModelPrompts();
      let pairEntry = modelPrompts?.[modelStr];
      if (!pairEntry && apiKey) {
        const keyRecord = await getApiKeyByKey(apiKey).catch(() => null);
        if (keyRecord?.id) {
          const keyModelPrompts = await getInjectKeyModelPrompts();
          pairEntry = keyModelPrompts?.[keyRecord.id]?.[modelStr];
        }
      }
      if (pairEntry?.enabled) return "round-robin";
    } catch {
      // Fail-open: a storage hiccup must never change routing.
    }
  }
  return "fallback";
}
