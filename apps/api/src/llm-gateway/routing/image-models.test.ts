import { describe, expect, test } from 'bun:test';
import { GatewayResolutionError } from '@kortix/llm-gateway';

import { hasImageOutput } from '../models/catalog-models';
import { type ImageReach, planImageRoute, reachableImageModels } from './image-models';

// The real runtime catalog (the bundled models.dev snapshot): the preference
// lists must name models it carries as image models.
const open = { disabledProviders: [], disabledModels: [] };
const reach = (names: string[], extra: Partial<ImageReach> = {}) =>
  async () => reachableImageModels({ secretNames: new Set(names), access: open, managedModels: [], ...extra });
const neverRead = async (): Promise<string[]> => { throw new Error('reachable models read'); };

async function refusal(plan: Promise<unknown>): Promise<GatewayResolutionError> {
  const error = await plan.then(() => null, (err: unknown) => err);
  expect(error).toBeInstanceOf(GatewayResolutionError);
  return error as GatewayResolutionError;
}

describe('image model route plan', () => {
  test('auto with only a ChatGPT connection plans codex/gpt-image-2', async () => {
    expect(await planImageRoute('auto', reach(['CODEX_AUTH_JSON']))).toEqual({
      policyId: 'image', primaryModel: 'codex/gpt-image-2', fallbackModels: [], fallbackOn: 'any-error',
    });
  });

  test('auto with a Google key and a ChatGPT connection plans codex first, then google', async () => {
    expect(await planImageRoute('auto', reach(['GOOGLE_GENERATIVE_AI_API_KEY', 'CODEX_AUTH_JSON']))).toEqual({
      policyId: 'image', primaryModel: 'codex/gpt-image-2',
      fallbackModels: ['google/gemini-2.5-flash-image'], fallbackOn: 'any-error',
    });
  });

  test('auto orders the BYOK providers openai, google, openrouter, xai', async () => {
    const plan = await planImageRoute('', reach(['XAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'OPENAI_API_KEY']));
    expect([plan.primaryModel, ...plan.fallbackModels!]).toEqual([
      'openai/gpt-image-1.5', 'google/gemini-2.5-flash-image',
      'openrouter/google/gemini-2.5-flash-image', 'xai/grok-imagine-image',
    ]);
  });

  test('a disabled model gives way to the next preference, a disabled provider plans nothing', async () => {
    const access = { disabledProviders: ['codex'], disabledModels: ['openai/gpt-image-1.5'] };
    const plan = await planImageRoute('auto', reach(['CODEX_AUTH_JSON', 'OPENAI_API_KEY'], { access }));
    expect([plan.primaryModel, ...plan.fallbackModels!]).toEqual(['openai/gpt-image-1']);
  });

  test('auto with no image-capable credential refuses image_model_unavailable', async () => {
    // A text-only provider key and a managed lineup without image output.
    const error = await refusal(planImageRoute('auto', reach(['ANTHROPIC_API_KEY'], { managedModels: ['deepseek-v4.1-flash'] })));
    expect(error.code).toBe('image_model_unavailable');
    expect(error.suggestion).toBe('Connect ChatGPT, or add an OpenAI, Google, xAI or OpenRouter key in project settings.');
  });

  test('an explicit text model refuses not_an_image_model and names available image models', async () => {
    const error = await refusal(planImageRoute('openai/gpt-5.5', reach(['CODEX_AUTH_JSON', 'XAI_API_KEY'])));
    expect(error.code).toBe('not_an_image_model');
    expect(error.message).toContain('openai/gpt-5.5');
    expect(error.suggestion).toContain('codex/gpt-image-2, xai/grok-imagine-image');
    // Nothing reachable: the suggestion says what to connect.
    const none = await refusal(planImageRoute('codex/gpt-5.5', reach([])));
    expect(none.suggestion).toBe('Connect ChatGPT, or add an OpenAI, Google, xAI or OpenRouter key in project settings.');
  });

  test('an explicit model the catalog marks image output but that does not generate images refuses not_an_image_model', async () => {
    // models.dev lists image output for Google's Deep Research agents and for routers.
    for (const model of ['google/deep-research-preview-04-2026', 'google/deep-research-max-preview-04-2026', 'openrouter/openrouter/auto']) {
      expect(hasImageOutput(model), model).toBe(true);
      const error = await refusal(planImageRoute(model, reach(['GOOGLE_GENERATIVE_AI_API_KEY'])));
      expect(error.code, model).toBe('not_an_image_model');
      expect(error.suggestion, model).toBe('Use an image model: google/gemini-2.5-flash-image.');
    }
  });

  test('an explicit catalog image model passes through as the primary', async () => {
    for (const [requested, wire] of [
      ['openrouter/google/gemini-2.5-flash-image', 'openrouter/google/gemini-2.5-flash-image'],
      ['kortix/xai/grok-imagine-image', 'xai/grok-imagine-image'],
      ['codex/gpt-image-2', 'codex/gpt-image-2'],
    ]) {
      expect(await planImageRoute(requested!, neverRead)).toEqual({
        policyId: 'image', primaryModel: wire, fallbackModels: [], fallbackOn: 'any-error',
      });
    }
  });

  test('an explicit custom-provider model is planned as the image primary', async () => {
    // The project named its own endpoint: its model is tried; resolveUpstream decides the rest.
    expect(await planImageRoute('my-vllm/flux-dev', neverRead, async () => ['my-vllm'])).toEqual({
      policyId: 'image', primaryModel: 'my-vllm/flux-dev', fallbackModels: [], fallbackOn: 'any-error',
    });
  });

  test("a model from another project's custom provider is refused as not_an_image_model", async () => {
    const error = await refusal(planImageRoute('other-vllm/flux-dev', reach([]), async () => ['my-vllm']));
    expect(error.code).toBe('not_an_image_model');
    // No custom-provider list at all (a principal without a project): refused too.
    expect((await refusal(planImageRoute('my-vllm/flux-dev', reach([])))).code).toBe('not_an_image_model');
  });

  test('auto ignores custom providers', async () => {
    const error = await refusal(planImageRoute('auto', reach(['CUSTOM_MY_VLLM_API_KEY']), async () => ['my-vllm']));
    expect(error.code).toBe('image_model_unavailable');
    // A catalog provider's text model and a bare managed id are still refused, not taken as custom.
    for (const model of ['openai/gpt-5.5', 'glm-5.3-flash']) {
      expect((await refusal(planImageRoute(model, reach([]), async () => ['my-vllm']))).code, model).toBe('not_an_image_model');
    }
  });
});
