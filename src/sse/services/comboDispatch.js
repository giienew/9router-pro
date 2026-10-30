// Shared combo dispatch (9Router Pro, P4-33 consolidation).
// The top-level combo branch, the nested combo branch (a combo member that
// is itself a combo, reached via handleSingleModelChat), and the solo
// capacity-adapter branch in src/sse/handlers/chat.js used to duplicate
// the same four steps: variant name/backing resolution, strategy
// resolution, capacity ordering, and fusion-vs-fallback dispatch with
// capacity-adapter stripping. They diverged once already (the nested
// fusion branch never recorded breaker success); this module is the one
// place that logic lives now. Behaviour is preserved exactly, including
// the nested branch's lack of breaker-success recording — that is an
// explicit option (`recordBreakerSuccess`), not an accidental difference,
// so a future change to it is a deliberate one-line decision.
import { resolveComboStrategy } from "./pairStrategy.js";
import { resolveComboMemberAttemptCap } from "./memberFailover.js";
import { orderModelsByCapacity } from "./capacityOrder.js";
import { resolveSmartChoice } from "./systemoneRouter.js";
import { filterAdapterModels } from "./keyAccess.js";
import { recordProviderSuccess } from "./providerBreaker.js";
import { parseModel } from "./model.js";
import { handleComboChat, handleFusionChat } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping } from "open-sse/services/capacityAdapter.js";

// Per-combo member pins (P3-28): settings.comboMemberPins[combo][member]
// names the connection that member should use. Stored value may be a bare
// connection id (legacy) or { id, label }; anything else means no pin.
// A missing/unavailable pinned connection falls back to normal selection
// inside getProviderCredentials (preferredConnectionId semantics).
export const memberPinFor = (settingsObj, comboName) => (member) => {
  const pin = settingsObj?.comboMemberPins?.[comboName]?.[member];
  if (typeof pin === "string") return pin;
  return pin?.id || null;
};

// Variant helpers shared by every combo branch: a member that names a
// variant carries its own bare name so its prompt fires; other members
// keep the requested combo name. `variantBacking` judges a variant member
// by its backing model for capacity ordering and breaker attribution.
export function createVariantHelpers(variants, fallbackName) {
  const isVariant = (m) =>
    typeof m === "string" && !m.includes("/") && variants?.[m];
  return {
    memberInjectName: (m) => (isVariant(m) ? m : fallbackName),
    variantBacking: (m) => (isVariant(m) ? variants[m].model || null : null),
  };
}

// Strip tool fields from a panel request: fusion panels judge bare
// answers, so tools/tool_choice must not reach a panel member.
export function stripPanelTools(clientRawRequest) {
  if (!clientRawRequest) return clientRawRequest;
  const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
  return { ...clientRawRequest, body: cleanBody };
}

// Breaker success signal (P3-27): a 2xx through a member closes a
// half-open breaker for that member's provider. `backingOf` maps a member
// string to the model string to parse (variants carry bare names — their
// backing model is what actually served). Never throws, never blocks.
export const withBreakerSuccess = (fn, backingOf) => async (b, m, ...rest) => {
  const r = await fn(b, m, ...rest);
  try {
    if (r?.ok) {
      const target = (backingOf ? backingOf(m) : null) || m;
      const p = parseModel(target);
      if (p?.provider) recordProviderSuccess(p.provider);
    }
  } catch { /* breaker bookkeeping must not fail the request */ }
  return r;
};

// P3-28 capacity strategy: reorder by live fleet capacity, then fall
// back in that order — rotation must not reshuffle it, so the combo
// runs as "fallback" over the capacity-ordered list.
export async function applyCapacityStrategy({ comboStrategy, models, getCapacityConnections, variantBacking, log, comboName }) {
  if (comboStrategy !== "capacity") return { effectiveStrategy: comboStrategy, orderedModels: models };
  const orderedModels = orderModelsByCapacity(models, await getCapacityConnections(), { resolveBacking: variantBacking });
  log?.info?.("CHAT", `Combo "${comboName}" capacity order → [${orderedModels.join(", ")}]`);
  return { effectiveStrategy: "fallback", orderedModels };
}

// Full combo dispatch for one combo name. `handleSingleModel` is the raw
// single-model runner with signature
//   (body, member, clientRawRequest, request, apiKey, null, injectName, cap, signal, pin)
// (i.e. handleSingleModelChat). `recordBreakerSuccess` preserves the one
// deliberate top-level/nested difference: the top-level branch records
// breaker success, the nested branch does not.
export async function dispatchCombo({
  body,
  comboName,
  comboModels,
  settings,
  apiKey,
  keyAccess,
  requiredCapabilities,
  variants,
  clientRawRequest,
  request,
  log,
  sessionId,
  handleSingleModel,
  getCapacityConnections,
  recordBreakerSuccess = true,
  // Nested branch only: a member that names no variant keeps the OUTER
  // requested name (injectModelName) rather than this combo's name, so
  // the outer variant's prompt still fires. Top-level passes nothing
  // and the fallback is the combo name itself.
  variantFallbackName = null,
}) {
  const { memberInjectName, variantBacking } = createVariantHelpers(variants, variantFallbackName || comboName);
  const pinFor = memberPinFor(settings, comboName);
  const cap = () => resolveComboMemberAttemptCap(settings);
  const comboStrategies = settings.comboStrategies || {};
  const comboStrategy = await resolveComboStrategy(comboName, comboModels, settings, apiKey);
  const augmentedModels = await filterAdapterModels(
    keyAccess,
    augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings, variantBacking),
    comboModels,
  );
  const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));
  const { effectiveStrategy, orderedModels } = await applyCapacityStrategy({
    comboStrategy, models: augmentedModels, getCapacityConnections, variantBacking, log, comboName,
  });

  if (comboStrategy === "fusion") {
    log?.info?.("CHAT", `Combo "${comboName}" with ${comboModels.length} models (strategy: fusion)`);
    const panelFn = (b, m, isPanel, signal) =>
      handleSingleModel(
        b, m,
        isPanel ? stripPanelTools(clientRawRequest) : clientRawRequest,
        request, apiKey, null, memberInjectName(m), cap(), signal, pinFor(m),
      );
    return handleFusionChat({
      body,
      models: comboModels,
      handleSingleModel: recordBreakerSuccess
        ? withBreakerSuccess(panelFn, (m) => variantBacking(m) || m)
        : panelFn,
      log,
      comboName,
      judgeModel: comboStrategies[comboName]?.judgeModel,
      tuning: comboStrategies[comboName]?.fusionTuning,
    });
  }

  const comboStickyLimit = settings.comboStickyRoundRobinLimit;
  const comboCfg = comboStrategies[comboName] || {};
  log?.info?.("CHAT", `Combo "${comboName}" with ${orderedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
  const inner = (b, m) =>
    handleSingleModel(b, m, clientRawRequest, request, apiKey, null, memberInjectName(m), cap(), undefined, pinFor(m));
  return handleComboChat({
    body,
    models: orderedModels,
    handleSingleModel: withCapacityAdapterStripping(
      recordBreakerSuccess ? withBreakerSuccess(inner, (m) => variantBacking(m) || m) : inner,
      adapterAdded,
      variantBacking,
    ),
    log,
    comboName,
    comboStrategy: effectiveStrategy,
    comboStickyLimit,
    sessionId,
    smartPolicy: comboCfg.smartPolicy || "smart",
    sessionSticky: comboCfg.sessionSticky !== false,
    confidenceThreshold: typeof comboCfg.confidenceThreshold === "number" ? comboCfg.confidenceThreshold : 0.8,
    resolveSmartChoice: comboStrategy === "smart"
      ? (b, m) => resolveSmartChoice({ body: b, models: m, routerModel: comboCfg.routerModel, log })
      : null,
  });
}
