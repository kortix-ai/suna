import { autoSeedableModels } from '@kortix/llm-catalog/lite';
import type { ProviderListResponse } from '@opencode-ai/sdk/v2/client';

import type { ModelDefaultsResponse } from '../rest/projects-client/model-defaults';
import { healBedrockModelKey } from './bedrock-invokable';
import { isOfferedModel, type FlatModel } from './model-flatten';
import { type ModelKey, wireToModelKey } from './model-key';

/**
 * Which model the session composer runs — framework-free, so every host
 * resolves the same default from the same inputs.
 */

/**
 * The gateway's configured default for an agent, from
 * `GET /projects/:id/model-defaults`: agent → project → account → platform.
 * A free-tier account never resolves the platform default.
 */
export function resolveModelDefault(
  data: ModelDefaultsResponse | undefined,
  agentName: string | undefined,
): ModelKey | undefined {
  const wire =
    (agentName ? data?.agentDefaults?.[agentName] : undefined) ??
    data?.projectDefault ??
    data?.accountDefault ??
    (data?.freeTier ? undefined : data?.platformDefault);
  return wire ? wireToModelKey(wire) : undefined;
}

export interface ComposerModelResolution {
  /** The model to display and send. Bare Bedrock ids healed to an inference profile. */
  model: ModelKey | undefined;
  /** The first valid explicit pick. `undefined` = the composer is on its default. */
  explicit: ModelKey | undefined;
  /** The last-resort default (config → recent → provider default). */
  fallback: ModelKey | undefined;
}

/**
 * Resolve the composer's model. Every candidate must be offered by `models`
 * (`isOfferedModel`: present and not `enabled: false`); an invalid one is
 * skipped, never sent.
 *
 * Priority: `picks` (in order) > `serverDefault` > `globalDefault` >
 * `agentModel` > fallback. Fallback: `configModel` (`provider/model`) > the
 * first valid `recent` > each connected provider's configured default, else
 * its first auto-seedable model (provider order = `providers.all`).
 */
export function resolveComposerModel(input: {
  /** The flattened picker list (`flattenModels`). */
  models: FlatModel[];
  /** Explicit picks, highest priority first (session slot, agent slot, …). */
  picks?: ReadonlyArray<ModelKey | undefined>;
  /** `resolveModelDefault(modelDefaults, agentName)`. */
  serverDefault?: ModelKey;
  /** The user's account-wide default. */
  globalDefault?: ModelKey;
  /** The current agent's configured `model`. */
  agentModel?: ModelKey;
  /** The runtime config's `model` (`provider/model`). */
  configModel?: string;
  /** Recently used models, newest first. */
  recent?: ReadonlyArray<ModelKey>;
  /** The provider list the models were flattened from. */
  providers?: ProviderListResponse;
}): ComposerModelResolution {
  const { models, providers } = input;
  const isValid = (model: ModelKey): boolean => isOfferedModel(models, model);
  const firstValid = (candidates: ReadonlyArray<ModelKey | undefined>): ModelKey | undefined =>
    candidates.find((model): model is ModelKey => !!model && isValid(model));

  const fallback = ((): ModelKey | undefined => {
    // Priority 1: Config model (from opencode.json)
    if (input.configModel) {
      const parts = input.configModel.split('/');
      if (parts.length >= 2) {
        const [providerID, ...rest] = parts;
        const modelID = rest.join('/');
        if (isValid({ providerID, modelID })) {
          return { providerID, modelID };
        }
      }
    }

    // Priority 2: Most recent valid model from persisted recent list
    for (const item of input.recent ?? []) {
      if (isValid(item)) {
        return item;
      }
    }

    // Priority 3: Provider defaults -> first model of first connected provider
    if (providers) {
      const defaults = providers.default || {};
      const all = Array.isArray(providers.all) ? providers.all : [];
      const connectedIds = Array.isArray(providers.connected) ? providers.connected : [];
      const connected = all.filter((p) => connectedIds.includes(p.id));
      for (const p of connected) {
        const configured = defaults[p.id];
        if (configured) {
          const key = { providerID: p.id, modelID: configured };
          if (isValid(key)) return key;
        }
        // `autoSeedableModels`, not the raw key order: on Bedrock the newest
        // id is the BARE `xai.grok-4.6`, which Bedrock refuses for on-demand
        // use. Auto-picking must never surface a bare id while the provider
        // serves inference profiles. Inert for every other provider.
        for (const model of autoSeedableModels(
          Object.keys(p.models).map((modelID) => ({ id: modelID })),
        )) {
          const key = { providerID: p.id, modelID: model.id };
          if (isValid(key)) return key;
        }
      }
    }

    return undefined;
  })();

  const explicit = firstValid(input.picks ?? []);
  const resolved =
    explicit ??
    firstValid([input.serverDefault, input.globalDefault, input.agentModel, fallback]);
  // EVERY source above can hand back a bare Bedrock in-region id — the
  // explicit slot most of all. Bedrock answers a hard 400 for those and
  // OpenCode retries forever, so heal here, at the single seam every source
  // funnels through. No-op off Bedrock.
  return { model: healBedrockModelKey(resolved, models), explicit, fallback };
}
