import { describe, expect, test } from 'bun:test';
import type { GatewayHooks, GatewayTrace, UpstreamDescriptor } from '../domain';
import { GatewayResolutionError } from '../errors';
import type { FetchImpl } from '../http';
import { type ImageRequest, handleImageRequest } from './images';

const FAKE_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
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
const silent = { info() {}, warn() {}, error() {} };

interface Call { url: string; init: RequestInit }

function okImage(headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ created: 1, data: [{ b64_json: FAKE_B64 }], size: '1254x1254' }), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function setup(over: Partial<GatewayHooks> = {}, fetchImpl?: FetchImpl) {
  const calls: Call[] = [];
  const traces: GatewayTrace[] = [];
  const hooks: GatewayHooks = {
    authenticate: async () => principal,
    authorize: async () => ({ ok: true, principal }),
    resolveUpstream: async (_p, model) => [{ ...codex, resolvedModel: model.replace(/^codex\//, '') }],
    assertBillingActive: async () => {},
    recordUsage: async () => {},
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
  return { calls, traces, run };
}

const sent = (call: Call) => JSON.parse(String(call.init.body)) as Record<string, unknown>;
const header = (call: Call, name: string) => new Headers(call.init.headers).get(name);

describe('handleImageRequest', () => {
  test('generations posts the prompt to the ChatGPT images endpoint with the login headers', async () => {
    const { calls, run } = setup();
    const response = await run({ model: 'codex/gpt-image-2', prompt: 'a red cube', size: 'auto' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://chatgpt.com/backend-api/codex/images/generations');
    expect(header(calls[0], 'authorization')).toBe('Bearer access-1');
    expect(header(calls[0], 'chatgpt-account-id')).toBe('acct-1');
    expect(sent(calls[0])).toEqual({ model: 'gpt-image-2', prompt: 'a red cube', n: 1, size: 'auto' });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: { b64_json: string }[] }).data[0].b64_json).toBe(FAKE_B64);
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
    const image = { image_url: 'data:image/png;base64,AAAA' };
    const refused = setup();
    const tooMany = await refused.run(
      { model: 'codex/gpt-image-2', prompt: 'make it blue', images: Array(6).fill(image) },
      { operation: 'edits' },
    );
    expect(tooMany.status).toBe(400);
    expect(((await tooMany.json()) as { code: string }).code).toBe('invalid_request');
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

  test('a model that is not a ChatGPT login is refused before any upstream call', async () => {
    const { calls, run } = setup({
      resolveUpstream: async () => [{ ...codex, provider: 'openai', resolvedModel: 'gpt-image-2' }],
    });
    const response = await run({ model: 'openai/gpt-image-2', prompt: 'a red cube' });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe('image_model_unsupported');
    expect(body.message).toBe('Image generation needs a connected ChatGPT account.');
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
    const body = (await response.json()) as { code: string; suggestion: string };
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
    expect(((await response.json()) as { code: string }).code).toBe('provider_reauth_required');
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
    const body = (await response.json()) as { code: string; retry_after: number };
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
      expect(((await response.json()) as { retry_after: number }).retry_after).toBe(expected);
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
      const body = (await response.json()) as { code: string; message: string; suggestion: string };
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
    expect(((await response.json()) as { code: string }).code).toBe('missing_token');
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

  test('unknown fields and other models are not forwarded', async () => {
    const other = setup();
    const refused = await other.run({ model: 'codex/gpt-image-1', prompt: 'a red cube', n: 10, user: 'x' });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { code: string }).code).toBe('image_model_unsupported');
    expect(other.calls).toHaveLength(0);

    const pinned = setup();
    const ok = await pinned.run({
      model: 'codex/gpt-image-2',
      prompt: 'a red cube',
      n: 10,
      user: 'x',
      stream: true,
      partial_images: 3,
      size: '1024x1024',
      quality: 'high',
      background: 'transparent',
      images: [{ image_url: 'data:image/png;base64,AAAA' }],
    });
    expect(ok.status).toBe(200);
    expect(Object.keys(sent(pinned.calls[0])).sort()).toEqual(['background', 'model', 'n', 'prompt', 'quality', 'size']);
    expect(sent(pinned.calls[0]).n).toBe(1);
  });

  test('an empty prompt is refused', async () => {
    const { calls, run } = setup();
    const response = await run({ model: 'codex/gpt-image-2', prompt: '  ' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe('invalid_request');
    expect(calls).toHaveLength(0);
  });
});
