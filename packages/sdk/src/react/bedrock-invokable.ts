import { autoSeedDefaultModel, bedrockInferenceProfileRank } from '@kortix/llm-catalog';

import type { FlatModel } from './model-flatten';
import { GATEWAY_PROVIDER_IDS } from './provider-selection';
import type { ModelKey } from './use-model-store';

/**
 * Resolution-time guard: a resolved model key must never be a bare Bedrock
 * in-region id when that provider serves cross-region inference profiles.
 *
 * *** THE PROBLEM THIS FIXES ***
 *
 * Bedrock refuses the bare id for its current model families — "Invocation of
 * model ID xai.grok-4.6 with on-demand throughput isn't supported. Retry your
 * request with the ID or ARN of an inference profile" — and OpenCode retries
 * forever ("Retrying in Ns"), so the session never produces a turn.
 *
 * Fixing the AUTO-SEEDED catalog default (`nativeProviderListFromCatalog`) is
 * necessary but not sufficient: that default is only Priority 3 of the LAST
 * source in `use-opencode-local`'s chain
 * (explicit > serverDefault > globalDefault > agent.model > fallback), and the
 * explicit slot is browser-global, not project-scoped —
 * `agentScopedModelSelectionKey(mode, agentName)` is `` `${mode}:${name ?? ''}` ``
 * (use-opencode-local.ts:226-231). The project-home composer has no agent and
 * no sessionId, so every native project in one browser shares the slot
 * `native:`. One earlier session pinned `xai.grok-4.6` there and every future
 * workspace inherited it, above anything the catalog default could say.
 * Observed on Essentia 2026-08-26 with a bundle that already carried the
 * catalog-default fix.
 *
 * On the GATEWAY path PR #6897 already re-prefixes a bare id after Bedrock's
 * 400. Native mode has no gateway and therefore no retry — this is its
 * analogue, applied BEFORE the request instead of after the failure.
 *
 * The rule, applied only within the key's OWN provider:
 *  0. a GATEWAY key (`providerID` in `GATEWAY_PROVIDER_IDS`) → untouched. Under
 *     the gateway every served model is registered as `kortix` and the real
 *     provider rides in the modelID prefix (`amazon-bedrock/…`, `openrouter/…`,
 *     `codex/…`), so "the same provider" would be the WHOLE catalog, and
 *     `bedrockInferenceProfileRank` strips that prefix — a Bedrock profile
 *     served through the gateway still ranks > 0. Without this step every
 *     gateway pick without a twin (an OpenRouter or Codex model, a bare Bedrock
 *     id) fell through to step 3 and "healed" to the newest Bedrock profile in
 *     the catalog: on Essentia (2026-08-27) the chip was pinned to Claude Opus 5
 *     (Global) whatever the user clicked, and every prompt was sent with it.
 *     The gateway re-prefixes a bare id itself after Bedrock's 400 (PR #6897);
 *     this guard is the native analogue and has no business on that path.
 *  1. already an inference profile (`global.`/regional) → untouched;
 *  2. a `global.` or regional twin of the same bare id is offered → use it
 *     (same model, invokable id — this also heals ids pinned or seeded before
 *     the fix);
 *  3. no twin, but the provider offers OTHER inference profiles → the bare id
 *     is not invokable here, so fall back to `autoSeedDefaultModel` over that
 *     provider's profiles;
 *  4. the provider offers no profile ids at all → untouched.
 *
 * Step 4 is what makes this inert for every non-Bedrock provider: no id there
 * ever scores `bedrockInferenceProfileRank > 0`. Returns the SAME object when
 * nothing changes, so callers can use it inside a memo without churn.
 */
export function healBedrockModelKey(
  key: ModelKey | undefined,
  offered: FlatModel[],
): ModelKey | undefined {
  if (!key) return key;
  if (GATEWAY_PROVIDER_IDS.has(key.providerID)) return key;
  if (bedrockInferenceProfileRank(key.modelID) > 0) return key;

  // `enabled === false` is the server's per-project "off" stamp — the same
  // predicate `isOfferedModel` applies. Never heal onto a model the picker
  // itself would refuse to offer.
  const siblings = offered.filter(
    (model) => model.providerID === key.providerID && model.enabled !== false,
  );
  if (!siblings.some((model) => bedrockInferenceProfileRank(model.modelID) > 0)) return key;

  // `global.` first, then any regional profile — the same precedence
  // `bedrockInferenceProfileRank` encodes, applied here explicitly so the
  // result never depends on which twin the catalog happens to list first.
  const isRegionalTwin = (modelID: string): boolean =>
    bedrockInferenceProfileRank(modelID) === 1 &&
    modelID.slice(modelID.indexOf('.') + 1) === key.modelID;
  const twin =
    siblings.find((model) => model.modelID === `global.${key.modelID}`) ??
    siblings.find((model) => isRegionalTwin(model.modelID));
  const replacement =
    twin?.modelID ??
    autoSeedDefaultModel(
      siblings.map((model) => ({ id: model.modelID, released: model.releaseDate })),
    )?.id;

  if (!replacement || replacement === key.modelID) return key;
  return { ...key, modelID: replacement };
}
