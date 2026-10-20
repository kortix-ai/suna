import { autoSeedableModels } from '@kortix/llm-catalog/lite';
import type { ProviderListResponse } from '../runtime/runtime-types';

import type { ModelDefaultsResponse } from '../rest/projects-client/model-defaults';
import { sessionModelPin } from '../rest/projects-client/sessions';
import { healBedrockModelKey } from './bedrock-invokable';
import { isOfferedModel, type FlatModel } from './model-flatten';
import { type ModelKey, modelRefToKey, wireToModelKey } from './model-key';

/**
 * Which model the session composer runs — framework-free, so every host
 * resolves the same default from the same inputs.
 */

/**
 * The gateway's configured default for an agent, from
 * `GET /projects/:id/model-defaults`: agent → project → account → platform.
 * An account without managed models gets no platform default from the API
 * (`resolvedForCaller` is null), and an unoffered model is skipped by the
 * caller's `isOfferedModel` validation either way.
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

/**
 * The model of the newest user message that records one: what the session
 * last ran on. Pass it to `sessionModelCandidates` as `lastPromptModel`.
 */
export function latestPromptModel(
  messages:
    | ReadonlyArray<{ role: string; model?: { provider?: string; model?: string } | null }>
    | null
    | undefined,
): ModelKey | undefined {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const message = messages![i]!;
    const { provider, model } = message.model ?? {};
    if (message.role === 'user' && provider && model) return { providerID: provider, modelID: model };
  }
  return undefined;
}

/** Pin sources that record a choice: a person's (CLI, SDK, Slack, `PUT /model`),
 *  or the platform's when it moved that choice off a retired model (`repointed`)
 *  or off a model that could not serve (`fallback`). */
const CHOSEN_PIN_SOURCES = new Set(['explicit', 'repointed', 'fallback']);

/**
 * The gateway moved this session to a fallback model because its own model
 * could not serve (a resting ChatGPT pool, a login that needs reconnecting, a
 * retired model). The server moves it back once `from` serves again.
 */
export interface SessionModelFallback {
  /** The model that answered, which the session now runs on. */
  model: ModelKey;
  /** The model it stands in for. */
  from: ModelKey;
  /** The gateway failure code (`provider_pool_rate_limited`, …). */
  reason: string;
  /** When the switch was recorded, epoch milliseconds. */
  atMs: number;
}

/** The session's fallback record (`metadata.opencode_model_source: 'fallback'`), if any. */
export function sessionModelFallback(
  session: { metadata?: Record<string, unknown> | null } | null | undefined,
  gatewayEnabled: boolean,
): SessionModelFallback | undefined {
  const metadata = session?.metadata;
  if (metadata?.opencode_model_source !== 'fallback') return undefined;
  const { opencode_model: pin, opencode_model_fallback_from: from, opencode_model_fallback_at: atMs } = metadata;
  if (typeof pin !== 'string' || typeof from !== 'string' || typeof atMs !== 'number') return undefined;
  const reason = metadata.opencode_model_fallback_reason;
  return {
    model: modelRefToKey(pin, gatewayEnabled),
    from: modelRefToKey(from, gatewayEnabled),
    reason: typeof reason === 'string' ? reason : 'other',
    atMs,
  };
}

/**
 * Does a pick this browser made for the session still outrank the server's
 * record? `pickedOverAtMs` is the `atMs` of the switch the composer showed
 * when the pick was made (undefined: none). A pick made before a switch does
 * not stand: sending it would name the model that cannot serve again. A pick
 * made while this switch was shown does. Both times are the server's, so a
 * browser clock that runs behind or ahead cannot lock the picker.
 */
export function sessionPickStands(
  pickedOverAtMs: number | undefined,
  fallback: SessionModelFallback | undefined,
): boolean {
  return !fallback || (pickedOverAtMs ?? -1) >= fallback.atMs;
}

/**
 * The models a session already runs on, as the server records them, most
 * trusted first. The composer ranks these after a pick made in this composer
 * for this session and before every cross-session pick and default, so a
 * session opens on its own model and its next prompt does not switch it.
 *
 * 1. A chosen pin (`metadata.opencode_model` with source `explicit` or
 *    `repointed`). The CLI, the SDK and Slack set the model this way, and
 *    they send it with every prompt.
 * 2. `lastPromptModel`: the model of the session's newest user message, which
 *    is what the session last ran on.
 *    A pin the server moved back off a fallback (`opencode_model_restored`)
 *    ranks here too until the next prompt runs on it, whatever its source.
 * 3. Any other pin. That is the default resolved when the session was
 *    created, which a later prompt may have replaced.
 */
export function sessionModelCandidates(input: {
  /** The session row (`getProjectSession`); its metadata holds the pin. */
  session?: { metadata?: Record<string, unknown> | null } | null;
  /** The model of the session's newest user message. */
  lastPromptModel?: ModelKey;
  /** The project's gateway mode: it decides how a stored pin parses. */
  gatewayEnabled: boolean;
}): ModelKey[] {
  const pin = input.session ? sessionModelPin(input.session) : null;
  const pinKey = pin ? modelRefToKey(pin, input.gatewayEnabled) : undefined;
  const metadata = input.session?.metadata;
  // `opencode_model_restored`: the server moved the pin back off a fallback
  // and no prompt has run on it yet, so the last prompt names the fallback.
  const chosen = CHOSEN_PIN_SOURCES.has(String(metadata?.opencode_model_source)) || metadata?.opencode_model_restored === true;
  const ordered = chosen
    ? [pinKey, input.lastPromptModel]
    : [input.lastPromptModel, pinKey];
  return ordered.filter((model): model is ModelKey => !!model);
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
