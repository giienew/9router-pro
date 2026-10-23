import { getApiKeyByKey, getInjectKeyModelPrompts, getInjectModelPrompts } from "@/lib/localDb";

/**
 * Resolve a combo's effective strategy (9Router Pro pair rotation).
 *
 * Precedence: the combo's own configured strategy, then the global
 * combo strategy, then the default. The default is "fallback" —
 * EXCEPT for a pair: a name carrying its own prompt injection (set on
 * the Prompt Injection page, for all keys or for the calling key)
 * backed by more than one model. A pair rotates its starting model
 * per request ("round-robin", sticky 1) so the load spreads across
 * the backing providers instead of the first model serving until it
 * fails; a failure still falls through the remaining models in
 * order. Storage errors fail open to "fallback".
 */
export async function resolveComboStrategy(modelStr, comboModels, settings, apiKey) {
  const comboStrategies = settings?.comboStrategies || {};
  const specific = comboStrategies[modelStr]?.fallbackStrategy;
  if (specific) return specific;
  if (settings?.comboStrategy) return settings.comboStrategy;

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
