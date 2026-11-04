import { GatewayResolutionError, type ModelRoutePlan } from '@kortix/llm-gateway';
import { modelAccessAllows, type ProjectModelAccess } from '../model-access';
import { hasImageOutput } from '../models/catalog-models';
import { isProviderConnected } from '../models/picker-catalog';
import { toWireModel } from '../resolution/effective';

/** The ChatGPT plan's image model: an image model whatever the catalog says. */
export const CHATGPT_IMAGE_MODEL = 'codex/gpt-image-2';

// Each BYOK provider's image model for `auto`, providers in plan order: the
// first id the catalog lists as an image model wins. A curated list, so `auto`
// plans only models whose image protocol the gateway speaks.
const BYOK_IMAGE_MODELS: ReadonlyArray<readonly [provider: string, ids: readonly string[]]> = [
  ['openai', ['gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini']],
  ['google', ['gemini-2.5-flash-image', 'gemini-3.1-flash-image']],
  ['openrouter', ['google/gemini-2.5-flash-image', 'google/gemini-3.1-flash-image']],
  ['xai', ['grok-imagine-image']],
];

const CONNECT_IMAGE_MODEL = 'Connect ChatGPT, or add an OpenAI, Google, xAI or OpenRouter key in project settings.';

// models.dev lists image output for models that do not generate an image from
// a prompt: Google's Deep Research agents (`google/deep-research-*`) and
// routers that pick a model per request (`openrouter/auto`). The catalog has
// no field that tells a generator apart (checked: modalities, family,
// tool_call, reasoning, cost), so this list does.
const NOT_IMAGE_GENERATORS = /(^|\/)(deep-research-|auto$)/;

/** An image model `/images/*` can call: the catalog lists image output and it generates images. */
const generatesImages = (wire: string): boolean =>
  wire === CHATGPT_IMAGE_MODEL || (hasImageOutput(wire) && !NOT_IMAGE_GENERATORS.test(wire));

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
  const usable = (model: string) => generatesImages(model) && modelAccessAllows(access, model);
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
 * model the project's model-access policy allows, or a model of one of the
 * project's custom providers (`customProviderIds`: the catalog knows nothing
 * of their models, so a named one is tried and the endpoint's answer decides,
 * R34). A disallowed explicit model is never planned: it falls through to the
 * access-filtered reachable models, which is what `auto` plans too; it never
 * plans a custom model. `access`, `reachable` and `customProviderIds` are read
 * only when the plan needs them.
 */
export async function planImageRoute(
  requestedModel: string,
  reachable: () => Promise<string[]>,
  access: () => Promise<ProjectModelAccess> = async () => ({ disabledProviders: [], disabledModels: [] }),
  customProviderIds: () => Promise<string[]> = async () => [],
): Promise<ModelRoutePlan> {
  const wire = toWireModel(requestedModel);
  if (wire && wire !== 'auto') {
    const provider = wire.includes('/') ? wire.split('/')[0]! : null;
    if (generatesImages(wire)) {
      // The project's own access policy disallows it: fall through to the reachable models
      // it allows, never plan a model the admission step would then refuse (KRTX-4035).
      if (modelAccessAllows(await access(), wire)) {
        return { policyId: 'image', primaryModel: wire, fallbackModels: [], fallbackOn: 'any-error' };
      }
    } else if (provider !== null && (await customProviderIds()).includes(provider)) {
      // A custom provider's model is outside the catalog and the policy's naming: try it (R34).
      return { policyId: 'image', primaryModel: wire, fallbackModels: [], fallbackOn: 'any-error' };
    } else {
      const models = (await reachable()).slice(0, 5);
      throw new GatewayResolutionError('not_an_image_model', `"${wire}" cannot generate images.`,
        models.length ? `Use an image model: ${models.join(', ')}.` : CONNECT_IMAGE_MODEL);
    }
  }
  const [primaryModel, ...fallbackModels] = await reachable();
  if (!primaryModel) {
    throw new GatewayResolutionError('image_model_unavailable', 'No image model is connected to this project.',
      CONNECT_IMAGE_MODEL);
  }
  return { policyId: 'image', primaryModel, fallbackModels, fallbackOn: 'any-error' };
}
