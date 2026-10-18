import { autoSeedableModels } from '@kortix/llm-catalog/lite';
import type { ProviderListResponse } from '../runtime/runtime-types';

import type { ModelDefaultsResponse } from '../rest/projects-client/model-defaults';
import { sessionModelPin } from '../rest/projects-client/sessions';
import { healBedrockModelKey } from './bedrock-invokable';
import { type FlatModel, isOfferedModel } from './model-flatten';
import { type ModelKey, modelRefToKey, wireToModelKey } from './model-key';

/**
 * Which model the session composer runs — framework-free, so every host
 * resolves the same default from the same inputs.
 */

/**
 * The gateway's configured default for an agent, from
 * `GET /projects/:id/model-defaults`: agent → project → account → platform.
 * The platform default resolves for every tier — the gateway serves it to
 * free tier too (KRTX-1067), and an unoffered model is skipped by the caller's
 * `isOfferedModel` validation either way.
 */
export function resolveModelDefault(
  data: ModelDefaultsResponse | undefined,
  agentName: string | undefined,
): ModelKey | undefined {
  const wire =
    (agentName ? data?.agentDefaults?.[agentName] : undefined) ??
    data?.projectDefault ??
    data?.accountDefault ??
    data?.platformDefault;
  return wire ? wireToModelKey(wire) : undefined;
}

/**
 * The model of the newest user message that records one: what the session
 * last ran on. Pass it to `sessionModelCandidates` as `lastPromptModel`.
 */
export function latestPromptModel(
  messages:
    | ReadonlyArray<{
        role: string;
        model?: { provider?: string; model?: string } | null;
      }>
    | null
    | undefined,
): ModelKey | undefined {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const message = messages![i]!;
    const { provider, model } = message.model ?? {};
    if (message.role === 'user' && provider && model)
      return { providerID: provider, modelID: model };
  }
  return undefined;
}

/** Pin sources that record a choice: a person's (CLI, SDK, Slack, `PUT /model`),
 *  or the platform's when it moved that choice off a retired model. */
const CHOSEN_PIN_SOURCES = new Set(['explicit', 'repointed']);

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
  const chosen = CHOSEN_PIN_SOURCES.has(String(input.session?.metadata?.opencode_model_source));
  const ordered = chosen ? [pinKey, input.lastPromptModel] : [input.lastPromptModel, pinKey];
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
 * The fallback chain when no explicit pick or named default is valid:
 * `configModel` (`provider/model`) > the first valid `recent` > each connected
 * provider's configured default, else its first auto-seedable model
 * (provider order = `providers.all`).
 */
function resolveFallbackModel(input: {
  models: FlatModel[];
  configModel?: string;
  recent?: ReadonlyArray<ModelKey>;
  providers?: ProviderListResponse;
}): ModelKey | undefined {
  const isValid = (model: ModelKey): boolean => isOfferedModel(input.models, model);

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
  if (input.providers) {
    const defaults = input.providers.default || {};
    const all = Array.isArray(input.providers.all) ? input.providers.all : [];
    const connectedIds = Array.isArray(input.providers.connected) ? input.providers.connected : [];
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
}

/**
 * Resolve the composer's model. Every candidate must be offered by `models`
 * (`isOfferedModel`: present and not `enabled: false`); an invalid one is
 * skipped, never sent.
 *
 * Priority: `picks` (in order) > `serverDefault` > `globalDefault` >
 * `agentModel` > fallback (see `resolveFallbackModel`).
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

  const explicit = firstValid(input.picks ?? []);
  const fallback = resolveFallbackModel(input);
  const resolved =
    explicit ?? firstValid([input.serverDefault, input.globalDefault, input.agentModel, fallback]);
  // EVERY source above can hand back a bare Bedrock in-region id — the
  // explicit slot most of all. Bedrock answers a hard 400 for those and
  // OpenCode retries forever, so heal here, at the single seam every source
  // funnels through. No-op off Bedrock.
  return { model: healBedrockModelKey(resolved, models), explicit, fallback };
}
