import { describe, expect, test } from 'bun:test';
import type { GatewayHooks, GatewayTrace, ModelRouteInput, ModelRoutePlan, UpstreamDescriptor, UsageEvent } from '../domain';
import { GatewayResolutionError } from '../errors';
import type { FetchImpl } from '../http';
import { type ImageRequest, handleImageRequest } from './images';

const FAKE_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_DATA_URL = 'data:image/png;base64,AAAA';
const principal = { userId: 'user-1', accountId: 'account-1', projectId: 'project-1' };
const codex: UpstreamDescriptor = {
  provider: 'openai-codex',
  kind: 'openai-responses',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  apiKey: 'access-1',
  billingMode: 'none',
  markup: 0,
  resolvedModel: 'gpt-image-2',
  refreshableCredential: true,
  poolSecretId: 'secret-1',
  headers: { originator: 'codex_cli_rs', 'ChatGPT-Account-ID': 'acct-1' },
};
const openai: UpstreamDescriptor = {
  provider: 'openai',
  kind: 'openai-compat',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-openai',
  billingMode: 'none',
  markup: 0,
  resolvedModel: 'gpt-image-1-mini',
  pricing: { inputPerMillion: 2, outputPerMillion: 8 },
};
const xai: UpstreamDescriptor = {
  provider: 'xai',
  kind: 'openai-compat',
  baseUrl: 'https://api.x.ai/v1',
  apiKey: 'xai-key',
  billingMode: 'none',
  markup: 0,
  resolvedModel: 'grok-imagine-image',
};
const google: UpstreamDescriptor = {
  provider: 'google',
  kind: 'openai-compat',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  apiKey: 'google-key',
  billingMode: 'none',
  markup: 0,
  resolvedModel: 'gemini-2.5-flash-image',
};
const openrouter: UpstreamDescriptor = {
  provider: 'openrouter',
  kind: 'openai-compat',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'or-key',
  billingMode: 'none',
  markup: 0,
  resolvedModel: 'google/gemini-2.5-flash-image',
};
const managed: UpstreamDescriptor = {
  provider: 'platinum',
  kind: 'openai-compat',
  baseUrl: 'https://inference.example.test/v1',
  apiKey: 'managed-key',
  billingMode: 'credits',
  markup: 1.5,
  resolvedModel: 'upstream-image-1',
  publicProvider: 'kortix',
  pricing: { inputPerMillion: 1, outputPerMillion: 30 },
};
const anthropic: UpstreamDescriptor = {
  provider: 'anthropic',
  kind: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  apiKey: 'anthropic-key',
  billingMode: 'none',
  markup: 0,
  resolvedModel: 'claude-sonnet-x',
};
const silent = { info() {}, warn() {}, error() {} };

interface Call { url: string; init: RequestInit }

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

// The upstream answers below are the live-probe shapes (2026-10-28) with the image bytes replaced.
function okImage(headers: Record<string, string> = {}): Response {
  return json({ created: 1, data: [{ b64_json: FAKE_B64 }], size: '1254x1254' }, 200, headers);
}
const openAiImage = () =>
  json({
    created: 1761638400,
    data: [{ b64_json: FAKE_B64 }],
    output_format: 'png',
    quality: 'low',
    size: '1024x1024',
    usage: {
      input_tokens: 20,
      input_tokens_details: { image_tokens: 0, text_tokens: 20 },
      output_tokens: 272,
      output_tokens_details: { image_tokens: 272, text_tokens: 0 },
      total_tokens: 292,
    },
  });
const xaiImage = () =>
  json({ data: [{ b64_json: FAKE_B64, mime_type: 'image/jpeg' }], usage: { cost_in_usd_ticks: 200_000_000 } });
const chatImage = (usage: Record<string, unknown> = { prompt_tokens: 9, completion_tokens: 1290, total_tokens: 1299, cost: 0.0387 }) =>
  json({
    id: 'gen-1',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: '',
        images: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${FAKE_B64}` } }],
      },
    }],
    usage,
  });
const geminiImage = () =>
  json({
    candidates: [{
      content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: FAKE_B64 } }] },
      finishReason: 'STOP',
    }],
    usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 1290, totalTokenCount: 1299 },
  });

/** A route plan the API returns for an image request (U-D2). */
function plan(primaryModel: string, ...fallbackModels: string[]): ModelRoutePlan {
  return { policyId: 'image', primaryModel, fallbackModels, fallbackOn: 'any-error' };
}

/** resolveUpstream over a model → descriptor table; any other model is not connected. */
function connected(table: Record<string, UpstreamDescriptor>): GatewayHooks['resolveUpstream'] {
  return async (_p, model) => {
    const descriptor = table[model];
    if (!descriptor) throw new GatewayResolutionError('provider_not_connected', `Connect ${model}.`, 'Connect it in Models.');
    return [descriptor];
  };
}

function setup(over: Partial<GatewayHooks> = {}, fetchImpl?: FetchImpl) {
  const calls: Call[] = [];
  const traces: GatewayTrace[] = [];
  const usage: UsageEvent[] = [];
  const hooks: GatewayHooks = {
    authenticate: async () => principal,
    authorize: async () => ({ ok: true, principal }),
    resolveUpstream: async (_p, model) => [{ ...codex, resolvedModel: model.replace(/^codex\//, '') }],
    assertBillingActive: async () => {},
    recordUsage: async (event) => { usage.push(event); },
    recordTrace: async (trace) => { traces.push(trace); },
    ...over,
  };
  const run = (body: unknown, extra: Partial<ImageRequest> = {}) =>
    handleImageRequest(
      {
        hooks,
        logger: silent,
        fetchImpl: async (url, init) => {
          calls.push({ url, init });
          return fetchImpl ? fetchImpl(url, init) : okImage();
        },
      },
      {
        authorization: 'Bearer session-token',
        rawBody: typeof body === 'string' ? body : JSON.stringify(body),
        operation: 'generations',
        ...extra,
      },
    );
  return { calls, traces, usage, run };
}

const sent = (call: Call) => JSON.parse(String(call.init.body)) as Record<string, unknown>;
const header = (call: Call, name: string) => new Headers(call.init.headers).get(name);
type ImageBody = { created: number; model: string; provider: string; data: { b64_json: string; mime_type: string }[]; size?: string };
type ErrorBody = { code: string; message: string; suggestion: string; retry_after?: number };

describe('handleImageRequest', () => {
  test('generations posts the prompt to the ChatGPT images endpoint with the login headers', async () => {
    const { calls, run } = setup();
    const response = await run({ model: 'codex/gpt-image-2', prompt: 'a red cube', aspect_ratio: 'auto' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://chatgpt.com/backend-api/codex/images/generations');
    expect(header(calls[0], 'authorization')).toBe('Bearer access-1');
    expect(header(calls[0], 'chatgpt-account-id')).toBe('acct-1');
    expect(sent(calls[0])).toEqual({ model: 'gpt-image-2', prompt: 'a red cube', n: 1, size: 'auto' });
    expect(response.status).toBe(200);
    expect(((await response.json()) as ImageBody).data[0].b64_json).toBe(FAKE_B64);
  });

  test('response is normalized to {created, model, provider, data[{b64_json, mime_type}]}', async () => {
    const { run } = setup();
    const response = await run({ model: 'codex/gpt-image-2', prompt: 'a red cube' });
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      created: 1,
      model: 'codex/gpt-image-2',
      provider: 'openai-codex',
      data: [{ b64_json: FAKE_B64, mime_type: 'image/png' }],
      size: '1254x1254',
    });
  });

  test('success forwards the ChatGPT image limit headers', async () => {
    const { run } = setup({}, async () => okImage({
      'x-codex-primary-used-percent': '12',
      'x-codex-primary-reset-after-seconds': '3600',
      'x-codex-primary-window-minutes': '1440',
      'x-codex-active-limit': 'imagegen_premium',
    }));
    const response = await run({ model: 'codex/gpt-image-2', prompt: 'a red cube' });
    expect(response.headers.get('x-codex-primary-used-percent')).toBe('12');
    expect(response.headers.get('x-codex-primary-reset-after-seconds')).toBe('3600');
    expect(response.headers.get('x-codex-primary-window-minutes')).toBe('1440');
    expect(response.headers.get('x-codex-active-limit')).toBeNull();
  });

  test('edits forwards at most five reference images', async () => {
    const image = { image_url: PNG_DATA_URL };
    const refused = setup();
    const tooMany = await refused.run(
      { model: 'codex/gpt-image-2', prompt: 'make it blue', images: Array(6).fill(image) },
      { operation: 'edits' },
    );
    expect(tooMany.status).toBe(400);
    expect(((await tooMany.json()) as ErrorBody).code).toBe('invalid_request');
    expect(refused.calls).toHaveLength(0);

    const accepted = setup();
    const five = await accepted.run(
      { model: 'codex/gpt-image-2', prompt: 'make it blue', images: Array(5).fill({ ...image, detail: 'x' }) },
      { operation: 'edits' },
    );
    expect(five.status).toBe(200);
    expect(accepted.calls[0].url).toBe('https://chatgpt.com/backend-api/codex/images/edits');
    expect(sent(accepted.calls[0]).images).toEqual(Array(5).fill(image));
  });

  test('openai-images generate and edit', async () => {
    const { calls, run } = setup({ resolveUpstream: async () => [openai] }, async () => openAiImage());
    const generated = await run({ model: 'openai/gpt-image-1-mini', prompt: 'a red cube', aspect_ratio: '3:2', quality: 'low' });
    expect(generated.status).toBe(200);
    expect(calls[0].url).toBe('https://api.openai.com/v1/images/generations');
    expect(header(calls[0], 'authorization')).toBe('Bearer sk-openai');
    // gpt-image models reject response_format and always answer base64.
    expect(sent(calls[0])).toEqual({ model: 'gpt-image-1-mini', prompt: 'a red cube', n: 1, size: '1536x1024', quality: 'low' });
    expect(((await generated.json()) as ImageBody).data).toEqual([{ b64_json: FAKE_B64, mime_type: 'image/png' }]);

    const edited = await run(
      { model: 'openai/gpt-image-1-mini', prompt: 'make it blue', aspect_ratio: '9:16', images: [{ image_url: PNG_DATA_URL }] },
      { operation: 'edits' },
    );
    expect(edited.status).toBe(200);
    expect(calls[1].url).toBe('https://api.openai.com/v1/images/edits');
    expect(sent(calls[1])).toEqual({
      model: 'gpt-image-1-mini',
      prompt: 'make it blue',
      n: 1,
      size: '1024x1536',
      images: [{ image_url: PNG_DATA_URL }],
    });
  });

  test('xAI gets response_format b64_json and no size', async () => {
    const { calls, run } = setup({ resolveUpstream: async () => [xai] }, async () => xaiImage());
    const response = await run({
      model: 'xai/grok-imagine-image',
      prompt: 'a red cube',
      aspect_ratio: '16:9',
      quality: 'high',
      background: 'transparent',
    });
    expect(response.status).toBe(200);
    expect(calls[0].url).toBe('https://api.x.ai/v1/images/generations');
    expect(header(calls[0], 'authorization')).toBe('Bearer xai-key');
    expect(sent(calls[0])).toEqual({ model: 'grok-imagine-image', prompt: 'a red cube', n: 1, response_format: 'b64_json' });
    const body = (await response.json()) as ImageBody;
    expect(body.data).toEqual([{ b64_json: FAKE_B64, mime_type: 'image/jpeg' }]);
    expect(body.provider).toBe('xai');
  });

  test('gemini native generate with aspect ratio and an edit with inlineData', async () => {
    const { calls, run } = setup({ resolveUpstream: async () => [google] }, async () => geminiImage());
    const generated = await run({ model: 'google/gemini-2.5-flash-image', prompt: 'a red cube', aspect_ratio: '16:9' });
    expect(generated.status).toBe(200);
    expect(calls[0].url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent',
    );
    expect(header(calls[0], 'x-goog-api-key')).toBe('google-key');
    expect(header(calls[0], 'authorization')).toBeNull();
    expect(sent(calls[0])).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'a red cube' }] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } },
    });
    expect(((await generated.json()) as ImageBody).data).toEqual([{ b64_json: FAKE_B64, mime_type: 'image/png' }]);

    const edited = await run(
      { model: 'google/gemini-2.5-flash-image', prompt: 'make it blue', aspect_ratio: 'auto', images: [{ image_url: PNG_DATA_URL }] },
      { operation: 'edits' },
    );
    expect(edited.status).toBe(200);
    expect(calls[1].url).toBe(calls[0].url);
    expect(sent(calls[1])).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'make it blue' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }] }],
      generationConfig: { responseModalities: ['IMAGE'] },
    });
  });

  test('chat-image reads message.images data URL', async () => {
    const { calls, run } = setup({ resolveUpstream: async () => [openrouter] }, async () => chatImage());
    const generated = await run({ model: 'openrouter/google/gemini-2.5-flash-image', prompt: 'a red cube', aspect_ratio: '3:2' });
    expect(generated.status).toBe(200);
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(header(calls[0], 'authorization')).toBe('Bearer or-key');
    expect(sent(calls[0])).toEqual({
      model: 'google/gemini-2.5-flash-image',
      messages: [{ role: 'user', content: 'a red cube' }],
      modalities: ['image', 'text'],
      image_config: { aspect_ratio: '3:2' },
    });
    expect(await generated.json()).toMatchObject({
      model: 'openrouter/google/gemini-2.5-flash-image',
      provider: 'openrouter',
      data: [{ b64_json: FAKE_B64, mime_type: 'image/png' }],
    });

    const edited = await run(
      { model: 'openrouter/google/gemini-2.5-flash-image', prompt: 'make it blue', images: [{ image_url: PNG_DATA_URL }] },
      { operation: 'edits' },
    );
    expect(edited.status).toBe(200);
    expect(sent(calls[1])).toEqual({
      model: 'google/gemini-2.5-flash-image',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'make it blue' }, { type: 'image_url', image_url: { url: PNG_DATA_URL } }],
      }],
      modalities: ['image', 'text'],
    });
  });

  test('auto falls back to the next planned model when the first is not connected', async () => {
    const routes: ModelRouteInput[] = [];
    const { calls, traces, run } = setup(
      {
        resolveRoute: async (_p, input) => {
          routes.push(input);
          return plan('codex/gpt-image-2', 'google/gemini-2.5-flash-image');
        },
        resolveUpstream: connected({ 'google/gemini-2.5-flash-image': google }),
      },
      async () => geminiImage(),
    );
    const response = await run({ prompt: 'a red cube' });
    expect(response.status).toBe(200);
    expect(routes[0]).toEqual({ requestedModel: 'auto', requires: { imageInput: false, imageOutput: true } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('generativelanguage.googleapis.com');
    expect(await response.json()).toMatchObject({ model: 'google/gemini-2.5-flash-image', provider: 'google' });
    expect(traces[0]).toMatchObject({ ok: true, servedModel: 'google/gemini-2.5-flash-image', fallbackFrom: 'codex/gpt-image-2' });

    await run({ prompt: 'make it blue', images: [{ image_url: PNG_DATA_URL }] }, { operation: 'edits' });
    expect(routes[1].requires).toEqual({ imageInput: true, imageOutput: true });
  });

  test('an upstream error moves to the next planned model, and the last failure is the answer', async () => {
    const served = setup(
      {
        resolveRoute: async () => plan('codex/gpt-image-2', 'openai/gpt-image-1-mini'),
        resolveUpstream: connected({ 'codex/gpt-image-2': codex, 'openai/gpt-image-1-mini': openai }),
      },
      async (url) => (url.includes('chatgpt.com') ? new Response('boom', { status: 500 }) : openAiImage()),
    );
    const ok = await served.run({ prompt: 'a red cube' });
    expect(ok.status).toBe(200);
    expect(served.calls.map((call) => new URL(call.url).hostname)).toEqual(['chatgpt.com', 'api.openai.com']);

    const failed = setup(
      {
        resolveRoute: async () => plan('codex/gpt-image-2', 'openai/gpt-image-1-mini'),
        resolveUpstream: connected({ 'codex/gpt-image-2': codex, 'openai/gpt-image-1-mini': openai }),
      },
      async (url) =>
        url.includes('chatgpt.com')
          ? new Response('limit', { status: 429, headers: { 'retry-after': '30' } })
          : json({ error: { message: 'Billing hard limit reached.' } }, 400),
    );
    const response = await failed.run({ prompt: 'a red cube' });
    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorBody;
    expect(body.code).toBe('image_upstream_error');
    expect(body.message).toBe('Billing hard limit reached.');
    expect(failed.traces[0].attemptFailures?.map((failure) => failure.code)).toEqual([
      'image_rate_limited',
      'image_upstream_error',
    ]);
  });

  test('no route plan: auto is image_model_unavailable, an explicit model is the only candidate', async () => {
    const { calls, run } = setup({ resolveRoute: async () => null });
    const auto = await run({ model: 'auto', prompt: 'a red cube' });
    expect(auto.status).toBe(400);
    const body = (await auto.json()) as ErrorBody;
    expect(body.code).toBe('image_model_unavailable');
    expect(body.suggestion).toBe('Connect ChatGPT, or add an OpenAI, Google, xAI or OpenRouter key in project settings.');
    expect(calls).toHaveLength(0);

    const explicit = await run({ model: 'codex/gpt-image-2', prompt: 'a red cube' });
    expect(explicit.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test('a route plan that is not an image plan is not used', async () => {
    const { calls, run } = setup({
      resolveRoute: async () => ({ policyId: 'platform-default', primaryModel: 'glm-5.3-flash' }),
    });
    const response = await run({ prompt: 'a red cube' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorBody).code).toBe('image_model_unavailable');
    expect(calls).toHaveLength(0);
  });

  test('a route refusal reaches the client with its code', async () => {
    const refusals = [
      ['auto', new GatewayResolutionError('image_model_unavailable', 'No image model is available for this project.', 'Connect ChatGPT, or add an OpenAI, Google, xAI or OpenRouter key in project settings.')],
      ['glm-5.3-flash', new GatewayResolutionError('not_an_image_model', 'glm-5.3-flash cannot generate images.', 'Use one of: codex/gpt-image-2.')],
    ] as const;
    for (const [model, refusal] of refusals) {
      const { calls, traces, run } = setup({ resolveRoute: async () => { throw refusal; } });
      const response = await run({ model, prompt: 'a red cube' });
      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorBody;
      expect(body.code).toBe(refusal.code);
      expect(body.message).toBe(refusal.message);
      expect(body.suggestion).toBe(refusal.suggestion);
      expect(calls).toHaveLength(0);
      expect(traces[0]).toMatchObject({ ok: false, status: 400, errorCode: refusal.code });
    }
  });

  test('every planned model failing at resolution answers the last model’s own code', async () => {
    const { calls, run } = setup({
      resolveRoute: async () => plan('google/gemini-2.5-flash-image', 'codex/gpt-image-2'),
      resolveUpstream: async (_p, model) => {
        throw model.startsWith('codex/')
          ? new GatewayResolutionError('provider_reauth_required', 'The ChatGPT login expired.', 'Reconnect ChatGPT in Models.')
          : new GatewayResolutionError('provider_not_connected', 'Connect Google.', 'Add a Google key.');
      },
    });
    const response = await run({ prompt: 'a red cube' });
    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorBody;
    expect(body.code).toBe('provider_reauth_required');
    expect(body.suggestion).toBe('Reconnect ChatGPT in Models.');
    expect(calls).toHaveLength(0);
  });

  test('anthropic descriptor is skipped as image_model_unsupported', async () => {
    const alone = setup({ resolveUpstream: async () => [anthropic] });
    const refused = await alone.run({ model: 'anthropic/claude-sonnet-x', prompt: 'a red cube' });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as ErrorBody).code).toBe('image_model_unsupported');
    expect(alone.calls).toHaveLength(0);

    const chained = setup(
      {
        resolveRoute: async () => plan('anthropic/claude-sonnet-x', 'openai/gpt-image-1-mini'),
        resolveUpstream: connected({ 'anthropic/claude-sonnet-x': anthropic, 'openai/gpt-image-1-mini': openai }),
      },
      async () => openAiImage(),
    );
    const served = await chained.run({ prompt: 'a red cube' });
    expect(served.status).toBe(200);
    expect(chained.calls.map((call) => call.url)).toEqual(['https://api.openai.com/v1/images/generations']);
  });

  test('managed without a price is skipped as image_model_unpriced', async () => {
    let billed = 0;
    const { calls, run } = setup({
      resolveUpstream: async () => [{ ...managed, pricing: undefined }],
      assertBillingActive: async () => { billed += 1; },
    });
    const response = await run({ model: 'kortix-image', prompt: 'a red cube' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorBody).code).toBe('image_model_unpriced');
    expect(calls).toHaveLength(0);
    expect(billed).toBe(0);
  });

  test('usage event per answered call: ChatGPT none, BYOK byok, OpenRouter cost taken from usage.cost, xAI cost from ticks', async () => {
    const cases: [UpstreamDescriptor, () => Response, Partial<UsageEvent>][] = [
      [codex, () => okImage(), { provider: 'openai-codex', model: 'gpt-image-2', upstreamCost: 0, finalCost: 0 }],
      [openai, openAiImage, { provider: 'openai', promptTokens: 20, completionTokens: 272, finalCost: 0 }],
      [openrouter, () => chatImage(), { provider: 'openrouter', upstreamCost: 0.0387, finalCost: 0 }],
      [xai, xaiImage, { provider: 'xai', upstreamCost: 0.02, finalCost: 0 }],
    ];
    for (const [descriptor, answer, expected] of cases) {
      const { usage, run } = setup({ resolveUpstream: async () => [descriptor] }, async () => answer());
      const response = await run({ model: 'some/image-model', prompt: 'a red cube' });
      expect(response.status).toBe(200);
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({
        ...expected,
        billingMode: 'none',
        streaming: false,
        accountId: 'account-1',
        projectId: 'project-1',
      });
    }
    // BYOK keeps its list price so the API can apply the BYOK fee: tokens × descriptor.pricing.
    const byok = setup({ resolveUpstream: async () => [openai] }, async () => openAiImage());
    await byok.run({ model: 'openai/gpt-image-1-mini', prompt: 'a red cube' });
    expect(byok.usage[0].upstreamCost).toBeCloseTo((20 * 2 + 272 * 8) / 1_000_000, 10);
  });

  test('the usage event names the image operation, so the host labels its usage row and debit', async () => {
    const { usage, run } = setup();
    await run({ model: 'codex/gpt-image-2', prompt: 'a red cube' });
    await run({ model: 'codex/gpt-image-2', prompt: 'make it blue', images: [{ image_url: PNG_DATA_URL }] }, { operation: 'edits' });
    expect(usage.map((event) => event.operation)).toEqual(['images.generations', 'images.edits']);
  });

  test('a managed model takes the wallet admission once, and its hold settles with the usage', async () => {
    let billed = 0;
    const { usage, run } = setup(
      {
        resolveUpstream: async () => [managed],
        assertBillingActive: async () => { billed += 1; return { holdUsd: 0.5 }; },
      },
      async () => chatImage({ prompt_tokens: 10, completion_tokens: 1000, total_tokens: 1010 }),
    );
    const response = await run({ model: 'kortix-image', prompt: 'a red cube' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ model: 'kortix-image', provider: 'kortix' });
    expect(billed).toBe(1);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      billingMode: 'credits',
      provider: 'kortix',
      model: 'kortix-image',
      upstream: { provider: 'platinum', model: 'upstream-image-1' },
      billingHoldUsd: 0.5,
    });
    expect(usage[0].upstreamCost).toBeCloseTo((10 * 1 + 1000 * 30) / 1_000_000, 10);
    expect(usage[0].finalCost).toBeCloseTo(usage[0].upstreamCost * 1.5, 10);
  });

  test('a failed managed request refunds its hold and names no upstream', async () => {
    const { usage, run } = setup(
      {
        resolveUpstream: async () => [managed],
        assertBillingActive: async () => ({ holdUsd: 0.5 }),
      },
      async () => json({ error: { message: 'vendor-x rejected upstream-image-1' } }, 400),
    );
    const response = await run({ model: 'kortix-image', prompt: 'a red cube' });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain('vendor-x');
    expect(text).not.toContain('upstream-image-1');
    expect(text).not.toContain('platinum');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ billingHoldUsd: 0.5, finalCost: 0, promptTokens: 0, completionTokens: 0 });
  });

  test('a managed model the wallet refuses answers 402 without an upstream call', async () => {
    const { calls, run } = setup({
      resolveUpstream: async () => [managed],
      assertBillingActive: async () => {
        throw Object.assign(new Error('Add credits to continue.'), { reason: 'insufficient_credits' });
      },
    });
    const response = await run({ model: 'kortix-image', prompt: 'a red cube' });
    expect(response.status).toBe(402);
    expect(((await response.json()) as ErrorBody).code).toBe('insufficient_credits');
    expect(calls).toHaveLength(0);
  });

  test('an unconnected ChatGPT account answers the resolution error', async () => {
    const { calls, run } = setup({
      resolveUpstream: async () => {
        throw new GatewayResolutionError('provider_not_connected', 'Connect a ChatGPT account.', 'Connect ChatGPT in Models.');
      },
    });
    const response = await run({ model: 'codex/gpt-image-2', prompt: 'a red cube' });
    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorBody;
    expect(body.code).toBe('provider_not_connected');
    expect(body.suggestion).toBe('Connect ChatGPT in Models.');
    expect(calls).toHaveLength(0);
  });

  test('a 401 refreshes the login once and retries', async () => {
    let n = 0;
    const { calls, run } = setup(
      { refreshCredential: async (_p, d) => ({ ...d, apiKey: 'access-2' }) },
      async () => (n++ === 0 ? new Response('expired', { status: 401 }) : okImage()),
    );
    const response = await run({ model: 'codex/gpt-image-2', prompt: 'a red cube' });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(header(calls[1], 'authorization')).toBe('Bearer access-2');
  });

  test('a 401 the login cannot refresh asks for reconnection', async () => {
    const { calls, run } = setup(
      { refreshCredential: async () => null },
      async () => new Response('expired', { status: 401 }),
    );
    const response = await run({ model: 'codex/gpt-image-2', prompt: 'a red cube' });
    expect(response.status).toBe(401);
    expect(((await response.json()) as ErrorBody).code).toBe('provider_reauth_required');
    expect(calls).toHaveLength(1);
  });

  test('an image 429 never cools the login for chat', async () => {
    const cooldowns: unknown[][] = [];
    const { run } = setup(
      { notePoolRateLimit: async (...args) => { cooldowns.push(args); } },
      async () => new Response('{"detail":"limit"}', {
        status: 429,
        headers: { 'retry-after': '120', 'x-codex-primary-reset-after-seconds': '3600' },
      }),
    );
    const response = await run({ model: 'codex/gpt-image-2', prompt: 'a red cube' });
    expect(cooldowns).toEqual([]);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('120');
    expect(response.headers.get('x-codex-primary-reset-after-seconds')).toBe('3600');
    const body = (await response.json()) as ErrorBody;
    expect(body.code).toBe('image_rate_limited');
    expect(body.retry_after).toBe(120);
  });

  test('a 429 retry time falls back to the ChatGPT reset header, then 60 s', async () => {
    for (const [headers, expected] of [
      [{ 'x-codex-primary-reset-after-seconds': '900' }, 900],
      [{}, 60],
    ] as const) {
      const { run } = setup({}, async () => new Response('limit', { status: 429, headers }));
      const response = await run({ model: 'codex/gpt-image-2', prompt: 'a red cube' });
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe(String(expected));
      expect(((await response.json()) as ErrorBody).retry_after).toBe(expected);
    }
  });

  test('a 429 on one pooled account moves to the next without a cooldown', async () => {
    let n = 0;
    const cooldowns: unknown[][] = [];
    const { calls, run } = setup(
      {
        resolveUpstream: async () => [codex, { ...codex, apiKey: 'access-b', poolSecretId: 'secret-2' }],
        notePoolRateLimit: async (...args) => { cooldowns.push(args); },
      },
      async () => (n++ === 0 ? new Response('limit', { status: 429, headers: { 'retry-after': '60' } }) : okImage()),
    );
    const response = await run({ model: 'codex/gpt-image-2', prompt: 'a red cube' });
    expect(response.status).toBe(200);
    expect(calls.map((c) => header(c, 'authorization'))).toEqual(['Bearer access-1', 'Bearer access-b']);
    expect(cooldowns).toEqual([]);
  });

  test('an upstream 4xx suggests a new prompt only for a safety refusal', async () => {
    const cases = [
      [400, '{"error":{"message":"Your request was rejected by the safety system.","code":"moderation_blocked"}}', 'Change the prompt or the reference images, then retry.'],
      [403, '{"error":{"message":"Forbidden for this account."}}', 'Retry, or check the ChatGPT connection in project settings.'],
    ] as const;
    for (const [status, raw, suggestion] of cases) {
      const { run } = setup({}, async () => new Response(raw, { status, headers: { 'content-type': 'application/json' } }));
      const response = await run({ model: 'codex/gpt-image-2', prompt: 'a red cube' });
      expect(response.status).toBe(status);
      const body = (await response.json()) as ErrorBody;
      expect(body.code).toBe('image_upstream_error');
      expect(body.message).toBe(JSON.parse(raw).error.message);
      expect(body.suggestion).toBe(suggestion);
    }
  });

  test('a missing bearer token is 401 before the body is read', async () => {
    let authed = false;
    const { calls, run } = setup({ authorize: async () => { authed = true; return { ok: true, principal }; } });
    const response = await run('not json', { authorization: undefined });
    expect(response.status).toBe(401);
    expect(((await response.json()) as ErrorBody).code).toBe('missing_token');
    expect(authed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test('the trace carries no prompt and no image bytes', async () => {
    const { traces, run } = setup();
    const response = await run({ model: 'codex/gpt-image-2', prompt: 'a red cube' });
    await response.text();
    expect(traces).toHaveLength(1);
    expect(traces[0].metadata.operation).toBe('images.generations');
    expect(traces[0].request).toBeNull();
    expect(traces[0].response).toBeNull();
    expect(traces[0].ok).toBe(true);
    const serialized = JSON.stringify(traces[0]);
    expect(serialized).not.toContain('a red cube');
    expect(serialized).not.toContain(FAKE_B64);
    expect(serialized).not.toContain('access-1');
  });

  test('client abort cancels the upstream fetch', async () => {
    const client = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    const { run } = setup({}, (_url, init) => {
      upstreamSignal = init.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    });
    const pending = run({ model: 'codex/gpt-image-2', prompt: 'a red cube' }, { signal: client.signal });
    await Bun.sleep(0);
    client.abort();
    const response = await pending;
    expect(upstreamSignal?.aborted).toBe(true);
    expect(response.status).toBe(499);
  });

  test('an abort while the answer is read tries no other model', async () => {
    const client = new AbortController();
    const { calls, run } = setup(
      {
        resolveRoute: async () => plan('codex/gpt-image-2', 'openai/gpt-image-1-mini'),
        resolveUpstream: connected({ 'codex/gpt-image-2': codex, 'openai/gpt-image-1-mini': openai }),
      },
      async (_url, init) => {
        if (init.signal?.aborted) throw init.signal.reason;
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":[{"b64_json":"'));
            init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
          },
        }), { status: 200 });
      },
    );
    const pending = run({ prompt: 'a red cube' }, { signal: client.signal });
    await Bun.sleep(0);
    client.abort();
    const response = await pending;
    expect(response.status).toBe(499);
    expect(calls).toHaveLength(1);
  });

  test('the 300 s budget ends the request as 504 and tries no other model', async () => {
    const { calls, usage, run } = setup(
      {
        resolveRoute: async () => plan('kortix-image', 'openai/gpt-image-1-mini'),
        resolveUpstream: connected({ 'kortix-image': managed, 'openai/gpt-image-1-mini': openai }),
        assertBillingActive: async () => ({ holdUsd: 0.5 }),
      },
      (_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }),
    );
    const response = await run({ prompt: 'a red cube' }, { timeoutMs: 5 });
    expect(response.status).toBe(504);
    expect(((await response.json()) as ErrorBody).code).toBe('image_timeout');
    expect(calls).toHaveLength(1);
    expect(usage).toEqual([expect.objectContaining({ billingHoldUsd: 0.5, finalCost: 0 })]);
  });

  test('a 200 without an image moves to the next model, refunds the hold, and charges nothing (R24)', async () => {
    const textOnly = () => json({ choices: [{ message: { role: 'assistant', content: 'I cannot draw that.' } }], usage: { prompt_tokens: 9, completion_tokens: 6, cost: 0.0001 } });
    const alone = setup({ resolveUpstream: async () => [managed], assertBillingActive: async () => ({ holdUsd: 0.5 }) }, async () => textOnly());
    const refused = await alone.run({ model: 'kortix-image', prompt: 'a red cube' });
    expect(refused.status).toBe(502);
    const body = (await refused.json()) as ErrorBody;
    expect(body.code).toBe('image_upstream_error');
    expect(body.message).toBe('kortix-image returned no image.');
    expect(alone.usage).toEqual([expect.objectContaining({ billingHoldUsd: 0.5, finalCost: 0, upstreamCost: 0 })]);
  });

  test('a managed hold is settled by an own-key model that answers after a fallback', async () => {
    let billed = 0;
    const { calls, usage, run } = setup(
      {
        resolveRoute: async () => plan('kortix-image', 'openai/gpt-image-1-mini'),
        resolveUpstream: connected({ 'kortix-image': managed, 'openai/gpt-image-1-mini': openai }),
        assertBillingActive: async () => { billed += 1; return { holdUsd: 0.5 }; },
      },
      async (url) =>
        url.includes('inference.example.test')
          ? json({ choices: [{ message: { role: 'assistant', content: 'no image' } }] })
          : openAiImage(),
    );
    const response = await run({ prompt: 'a red cube' });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(billed).toBe(1);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ billingMode: 'none', provider: 'openai', billingHoldUsd: 0.5, finalCost: 0 });
  });

  test('a managed 401 says the model is unavailable, not to check a key, and the trace names the billing mode', async () => {
    const { traces, run } = setup(
      { resolveUpstream: async () => [managed], assertBillingActive: async () => ({ holdUsd: 0.5 }) },
      async () => new Response('{"error":{"message":"bad key"}}', { status: 401 }),
    );
    const response = await run({ model: 'kortix-image', prompt: 'a red cube' });
    const body = (await response.json()) as ErrorBody;
    expect(response.status).toBe(502);
    expect(body.code).toBe('image_upstream_error');
    expect(body.message).toBe('kortix-image is unavailable right now.');
    expect(body.suggestion).toBe('Retry, or choose another image model.');
    expect(JSON.stringify(body)).not.toContain('key');
    expect(traces[0]).toMatchObject({ ok: false, billingMode: 'credits', provider: 'kortix' });
  });

  test('a Phase 1 size without aspect_ratio maps to the matching aspect ratio', async () => {
    for (const [size, aspect] of [['1536x1024', '3:2'], ['1024x1536', '2:3'], ['1024x1024', '1:1'], ['auto', 'auto']] as const) {
      const codexRun = setup();
      await codexRun.run({ model: 'codex/gpt-image-2', prompt: 'a red cube', size });
      expect(sent(codexRun.calls[0]).size).toBe(size);
      const chat = setup({ resolveUpstream: async () => [openrouter] }, async () => chatImage());
      await chat.run({ model: 'openrouter/x', prompt: 'a red cube', size });
      expect(sent(chat.calls[0]).image_config).toEqual(aspect === 'auto' ? undefined : { aspect_ratio: aspect });
    }
    const both = setup();
    await both.run({ model: 'codex/gpt-image-2', prompt: 'a red cube', size: '1536x1024', aspect_ratio: '1:1' });
    expect(sent(both.calls[0]).size).toBe('1024x1024');
  });

  test('a declared answer over 48 MiB is refused unread and moves to the next model', async () => {
    let pulled = false;
    const { calls, traces, run } = setup(
      {
        resolveRoute: async () => plan('openrouter/x', 'openai/gpt-image-1-mini'),
        resolveUpstream: connected({ 'openrouter/x': openrouter, 'openai/gpt-image-1-mini': openai }),
      },
      async (url) =>
        url.includes('openrouter')
          ? new Response(new ReadableStream({ pull(c) { pulled = true; c.enqueue(new Uint8Array(1024)); c.close(); } }, { highWaterMark: 0 }), {
              status: 200,
              headers: { 'content-length': String(49 * 1024 * 1024) },
            })
          : openAiImage(),
    );
    const response = await run({ prompt: 'a red cube' });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(pulled).toBe(false);
    expect(traces[0].attemptFailures?.[0]).toMatchObject({ code: 'image_response_too_large' });
  });

  test('a chunked answer is cut at 48 MiB as image_response_too_large', async () => {
    const MiB = 1024 * 1024;
    let sentBytes = 0;
    const { run } = setup({ resolveUpstream: async () => [openrouter] }, async () =>
      new Response(new ReadableStream({
        pull(c) {
          if (sentBytes >= 64 * MiB) return c.close();
          sentBytes += MiB;
          c.enqueue(new Uint8Array(MiB));
        },
      }), { status: 200 }),
    );
    const response = await run({ model: 'openrouter/x', prompt: 'a red cube' });
    expect(response.status).toBe(502);
    expect(((await response.json()) as ErrorBody).code).toBe('image_response_too_large');
    expect(sentBytes).toBeLessThan(52 * MiB);
  });

  test('an error body is read at most 64 KiB', async () => {
    const KiB = 1024;
    let sentBytes = 0;
    const { run } = setup({ resolveUpstream: async () => [openai] }, async () =>
      new Response(new ReadableStream({
        pull(c) {
          if (sentBytes >= 10 * 1024 * KiB) return c.close();
          sentBytes += 16 * KiB;
          c.enqueue(new TextEncoder().encode('x'.repeat(16 * KiB)));
        },
      }), { status: 400 }),
    );
    const response = await run({ model: 'openai/gpt-image-1-mini', prompt: 'a red cube' });
    expect(response.status).toBe(400);
    expect(sentBytes).toBeLessThanOrEqual(128 * KiB);
    expect(((await response.json()) as ErrorBody).message.length).toBeLessThanOrEqual(64 * KiB);
  });

  test('unknown fields are not forwarded and n is always 1', async () => {
    const { calls, run } = setup();
    const ok = await run({
      model: 'codex/gpt-image-2',
      prompt: 'a red cube',
      n: 10,
      user: 'x',
      stream: true,
      partial_images: 3,
      size: '256x256',
      aspect_ratio: '1:1',
      quality: 'high',
      background: 'transparent',
      images: [{ image_url: PNG_DATA_URL }],
    });
    expect(ok.status).toBe(200);
    expect(sent(calls[0])).toEqual({
      model: 'gpt-image-2',
      prompt: 'a red cube',
      n: 1,
      size: '1024x1024',
      quality: 'high',
      background: 'transparent',
    });
  });

  test('an empty prompt or an unknown aspect_ratio is refused', async () => {
    const { calls, run } = setup();
    for (const body of [
      { model: 'codex/gpt-image-2', prompt: '  ' },
      { model: 'codex/gpt-image-2', prompt: 'a red cube', aspect_ratio: '5:4' },
    ]) {
      const response = await run(body);
      expect(response.status).toBe(400);
      expect(((await response.json()) as ErrorBody).code).toBe('invalid_request');
    }
    expect(calls).toHaveLength(0);
  });
});
