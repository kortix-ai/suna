import { GatewayResolutionError, type ModelRoutePlan } from '@kortix/llm-gateway';
import { modelAccessAllows, type ProjectModelAccess } from '../model-access';
import { hasImageOutput } from '../models/catalog-models';
import { isProviderConnected } from '../models/picker-catalog';
import { toWireModel } from '../resolution/effective';

/** The ChatGPT plan's image model: an image model whatever the catalog says. */
export const CHATGPT_IMAGE_MODEL = 'codex/gpt-image-2';

// Each BYOK provider's image model for `auto`, providers in plan order: the
// first id the catalog lists as an image model wins. A curated list, because
// models.dev also gives image output to models that do not generate images
// (Google `deep-research-*`).
const BYOK_IMAGE_MODELS: ReadonlyArray<readonly [provider: string, ids: readonly string[]]> = [
  ['openai', ['gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini']],
  ['google', ['gemini-2.5-flash-image', 'gemini-3.1-flash-image']],
  ['openrouter', ['google/gemini-2.5-flash-image', 'google/gemini-3.1-flash-image']],
  ['xai', ['grok-imagine-image']],
];

const CONNECT_IMAGE_MODEL = 'Connect ChatGPT, or add an OpenAI, Google, xAI or OpenRouter key in project settings.';

export interface ImageReach {
  /** Credential names the principal reaches: project secrets and granted pooled keys. */
  secretNames: Set<string>;
  access: ProjectModelAccess;
  /** The served managed lineup the account may use. */
  managedModels: readonly string[];
}

/**
 * The image models the principal can reach, in `auto` order: the ChatGPT
 * connection, each connected BYOK provider's image model, then managed models
 * with image output. Credential names only: the gateway's `resolveUpstream`
 * still decides each one, and a failed one falls to the next.
 */
export function reachableImageModels({ secretNames, access, managedModels }: ImageReach): string[] {
  const usable = (model: string) => hasImageOutput(model) && modelAccessAllows(access, model);
  return [
    ...(secretNames.has('CODEX_AUTH_JSON') && modelAccessAllows(access, CHATGPT_IMAGE_MODEL) ? [CHATGPT_IMAGE_MODEL] : []),
    ...BYOK_IMAGE_MODELS.flatMap(([provider, ids]) => {
      const model = isProviderConnected(provider, secretNames) && ids.map((id) => `${provider}/${id}`).find(usable);
      return model ? [model] : [];
    }),
    ...managedModels.filter(usable),
  ];
}

/**
 * The route of an `/images/*` request. An explicit model must be an image
 * model and gets no fallback. `auto` (or none) plans every reachable image
 * model, in order. `reachable` is read only when the plan needs it.
 */
export async function planImageRoute(
  requestedModel: string,
  reachable: () => Promise<string[]>,
): Promise<ModelRoutePlan> {
  const wire = toWireModel(requestedModel);
  if (wire && wire !== 'auto') {
    if (wire === CHATGPT_IMAGE_MODEL || hasImageOutput(wire)) {
      return { policyId: 'image', primaryModel: wire, fallbackModels: [], fallbackOn: 'any-error' };
    }
    const models = (await reachable()).slice(0, 5);
    throw new GatewayResolutionError('not_an_image_model', `"${wire}" cannot generate images.`,
      models.length ? `Use an image model: ${models.join(', ')}.` : CONNECT_IMAGE_MODEL);
  }
  const [primaryModel, ...fallbackModels] = await reachable();
  if (!primaryModel) {
    throw new GatewayResolutionError('image_model_unavailable', 'No image model is connected to this project.',
      CONNECT_IMAGE_MODEL);
  }
  return { policyId: 'image', primaryModel, fallbackModels, fallbackOn: 'any-error' };
}
