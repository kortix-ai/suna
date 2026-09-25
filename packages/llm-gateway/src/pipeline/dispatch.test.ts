import { describe, expect, test } from 'bun:test';
import type { UpstreamDescriptor } from '../domain';
import { UpstreamHttpError } from '../errors';
import {
  type DispatchContext,
  type DispatchPlan,
  UPSTREAM_HEADERS_TIMEOUT_MS,
  dispatch,
  upstreamHeadersTimeoutMs,
  withUpstreamHeadersTimeout,
} from './dispatch';

// Every attempt goes through the real transport (`callUpstream`): the direct
// OpenAI-compatible request, or the AI SDK Bedrock Converse request. Only the
// network is fake: `fetchImpl` records each request and answers per row.

function upstream(provider: string, overrides: Partial<UpstreamDescriptor> = {}): UpstreamDescriptor {
  return {
    provider,
    kind: 'openai-compat',
    baseUrl: `https://${provider}.example/v1`,
    apiKey: 'key',
    billingMode: 'credits',
    markup: 1,
    ...overrides,
  };
}

const base = upstream('provider-a');

function bedrock(resolvedModel: string, overrides: Partial<UpstreamDescriptor> = {}): UpstreamDescriptor {
  return upstream('amazon-bedrock', { kind: 'bedrock', resolvedModel, ...overrides });
}

interface Sent {
  /** The host the request went to: the provider of an OpenAI-compatible candidate. */
  host: string;
  key: string;
  /** The model on the wire: the OpenAI body's `model`, or the Bedrock URL's model id. */
  model: string;
  body: Record<string, unknown>;
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
const ok = () => json({ choices: [] });
const status = (code: number, headers?: Record<string, string>) =>
  new Response(`status ${code}`, { status: code, headers });
const converseOk = () =>
  json({
    output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
    stopReason: 'end_turn',
    usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
  });
// Bedrock's refusal of a bare model id, as its Converse API answers it.
const profileRefusal = () =>
  json(
    {
      message:
        'Invocation of model ID xai.grok-4.6 with on-demand throughput isn’t supported. Retry your request with the ID or ARN of an inference profile that contains this model.',
    },
    400,
  );

function harness(reply: (sent: Sent, index: number) => Response | Error, overrides: Partial<DispatchContext> = {}) {
  const sent: Sent[] = [];
  const cooldowns: Array<[string, number]> = [];
  const resolved: string[] = [];
  const ctx: DispatchContext = {
    requestId: 'req_test',
    logger: { info() {}, warn() {}, error() {} },
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const converse = url.pathname.match(/\/model\/([^/]+)\/converse/);
      const entry: Sent = {
        host: url.hostname.split('.')[0]!,
        key: (new Headers(init.headers).get('authorization') ?? '').replace(/^Bearer /, ''),
        model: converse ? decodeURIComponent(converse[1]!) : String(body.model),
        body,
      };
      sent.push(entry);
      const result = reply(entry, sent.length - 1);
      if (result instanceof Error) throw result;
      return result;
    },
    resolveCandidates: async (model) => {
      resolved.push(model);
      return [upstream(`${model}-upstream`)];
    },
    notePoolRateLimit: async (secretId, seconds) => {
      cooldowns.push([secretId, seconds]);
    },
    ...overrides,
  };
  const run = (plan: DispatchPlan, body: Record<string, unknown> = { messages: [{ role: 'user', content: 'hi' }] }) =>
    dispatch(body, plan, ctx);
  return { run, sent, cooldowns, resolved };
}

describe('dispatch: one attempt plan', () => {
  test('a pool key and its Bedrock inference profile compose', async () => {
    const key = (name: string) => bedrock('xai.grok-4.6', { apiKey: name, poolSecretId: name, billingMode: 'none', markup: 0 });
    const { run, sent, cooldowns } = harness(({ key: apiKey, model }) => {
      if (model === 'xai.grok-4.6') return profileRefusal();
      if (apiKey === 'a') return json({ message: 'Too many requests' }, 429, { 'retry-after': '5' });
      return converseOk();
    });
    const outcome = await run({ model: 'amazon-bedrock/xai.grok-4.6', candidates: [key('a'), key('b')] });
    expect(sent.map((s) => `${s.key}:${s.model}`)).toEqual([
      'a:xai.grok-4.6',
      'a:global.xai.grok-4.6',
      'b:xai.grok-4.6',
      'b:global.xai.grok-4.6',
    ]);
    expect(outcome.response?.status).toBe(200);
    expect(outcome.descriptor).toMatchObject({ apiKey: 'b', resolvedModel: 'global.xai.grok-4.6' });
    expect(cooldowns).toEqual([['a', 5]]);
    expect(outcome.candidatesTried).toEqual([
      'amazon-bedrock:a',
      'amazon-bedrock:a:global.xai.grok-4.6',
      'amazon-bedrock:b',
      'amazon-bedrock:b:global.xai.grok-4.6',
    ]);
  });

  test('Bedrock inference profiles are tried global first, then us, then the refusal is final', async () => {
    const { run, sent } = harness(() => profileRefusal());
    const outcome = await run({ model: 'm', candidates: [bedrock('xai.grok-4.6')] });
    expect(sent.map((s) => s.model)).toEqual(['xai.grok-4.6', 'global.xai.grok-4.6', 'us.xai.grok-4.6']);
    expect(outcome.error).toBeInstanceOf(UpstreamHttpError);
  });

  test('a refused reasoning_effort is dropped once, and a second refusal is final', async () => {
    const { run, sent } = harness(() => json({ message: 'unknown_parameter: reasoning_effort is not supported' }, 400));
    const outcome = await run(
      { model: 'm', candidates: [bedrock('openai.dispatch-effort')] },
      { messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'high' },
    );
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[0]!.body)).toContain('high');
    expect(JSON.stringify(sent[1]!.body)).not.toContain('high');
    expect(outcome.error).toMatchObject({ status: 400 });
  });

  test('every pool key rate-limited returns a 429 carrying the earliest cooldown and the provider body', async () => {
    const key = (name: string) => ({ ...base, apiKey: name, poolSecretId: name, billingMode: 'none' as const, markup: 0 });
    const { run, cooldowns } = harness(({ key: apiKey }) =>
      new Response('{"error":"limited"}', { status: 429, headers: { 'retry-after': apiKey === 'a' ? '40' : '6' } }),
    );
    const outcome = await run({ model: 'm', candidates: [key('a'), key('b')] });
    expect(outcome.response?.status).toBe(429);
    expect(outcome.response?.headers.get('retry-after')).toBe('6');
    expect(await outcome.response?.text()).toBe('{"error":"limited"}');
    expect(cooldowns).toEqual([['a', 40], ['b', 6]]);
  });

  test('a failover chain skips candidates that did not opt in', async () => {
    const chain = [
      upstream('first', { failover: true }),
      upstream('no-opt-in'),
      upstream('third', { failover: true }),
    ];
    const { run, sent } = harness((s) => (s.host === 'third' ? ok() : status(500)));
    const outcome = await run({ model: 'm', candidates: chain });
    expect(sent.map((s) => s.host)).toEqual(['first', 'third']);
    expect(outcome.attemptFailures.map((f) => [f.provider, f.status])).toEqual([['first', 500]]);
  });

  test('fallback models are resolved lazily, deduplicated, and capped at eight', async () => {
    const { run, sent, resolved } = harness(() => status(503));
    await run({
      model: 'm',
      candidates: [base],
      fallbackModels: ['a', 'm', 'a', 'b', '', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
    });
    expect(resolved).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    expect(sent.map((s) => s.model)).toEqual(['m', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  });

  test('a served attempt never resolves a fallback model', async () => {
    const { run, resolved } = harness(() => ok());
    const outcome = await run({ model: 'm', candidates: [base], fallbackModels: ['f'] });
    expect(resolved).toEqual([]);
    expect(outcome.model).toBe('m');
  });

  test('a fallback model that cannot be resolved is skipped', async () => {
    const { run, sent } = harness((s) => (s.host === 'g-upstream' ? ok() : status(503)), {
      resolveCandidates: async (model) => {
        if (model === 'f') throw new Error('provider not connected');
        return [upstream(`${model}-upstream`)];
      },
    });
    const outcome = await run({ model: 'm', candidates: [base], fallbackModels: ['f', 'g'] });
    expect(sent.map((s) => s.host)).toEqual(['provider-a', 'g-upstream']);
    expect(outcome.response?.status).toBe(200);
  });

  test.each([
    ['transient', 1],
    ['any-error', 2],
  ] as const)('a %s chain after a request error sends %i request(s)', async (fallbackOn, expected) => {
    const { run, sent } = harness(() => status(400));
    await run({ model: 'm', candidates: [base], fallbackModels: ['f'], fallbackOn });
    expect(sent).toHaveLength(expected);
  });

  test.each([
    ['402', () => status(402)],
    ['403', () => status(403)],
    ['429', () => status(429)],
    ['500', () => status(500)],
    ['a network error', () => new TypeError('fetch failed')],
  ])('a transient chain moves past %s', async (_name, reply) => {
    const { run, sent } = harness((_s, index) => (index === 0 ? reply() : ok()));
    const outcome = await run({ model: 'm', candidates: [base], fallbackModels: ['f'] });
    expect(sent).toHaveLength(2);
    expect(outcome.model).toBe('f');
  });

  test('a BYOK primary skips Kortix-billed fallback candidates', async () => {
    const byok: UpstreamDescriptor = { ...base, billingMode: 'none', markup: 0 };
    const { run, sent } = harness(() => status(503), {
      resolveCandidates: async (model) => [
        upstream(`${model}-managed`),
        ...(model === 'g' ? [upstream('g-byok', { billingMode: 'none', markup: 0 })] : []),
      ],
    });
    await run({ model: 'm', candidates: [byok], fallbackModels: ['f', 'g'] });
    expect(sent.map((s) => s.host)).toEqual(['provider-a', 'g-byok']);
  });

  test('a client that left stops the plan', async () => {
    const client = new AbortController();
    const { run, sent } = harness(
      () => {
        client.abort();
        return new DOMException('The operation was aborted.', 'AbortError');
      },
      { signal: client.signal },
    );
    const outcome = await run({
      model: 'm',
      candidates: [upstream('first', { failover: true }), upstream('second', { failover: true })],
      fallbackModels: ['f'],
      fallbackOn: 'any-error',
    });
    expect(sent).toHaveLength(1);
    expect(outcome.error).toBeInstanceOf(DOMException);
  });

  test('a publicly named candidate records a classified failure, never the upstream text', async () => {
    const managed = (provider: string) => upstream(provider, { failover: true, publicProvider: 'kortix' });
    const { run } = harness((s) =>
      s.host === 'upstream-a' ? new Response('upstream-a key rejected', { status: 401 }) : ok(),
    );
    const outcome = await run({ model: 'm', candidates: [managed('upstream-a'), managed('upstream-b')] });
    expect(outcome.attemptFailures).toEqual([
      expect.objectContaining({ provider: 'kortix', resolvedModel: 'm', code: 'model_unavailable', status: 401 }),
    ]);
    expect(JSON.stringify(outcome.attemptFailures)).not.toContain('upstream-a');
    expect(outcome.candidatesTried).toEqual(['kortix', 'kortix']);
  });
});

describe('the provider response-header deadline', () => {
  test('aborts a provider fetch that does not return response headers before the deadline', async () => {
    const fetchWithTimeout = withUpstreamHeadersTimeout(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }),
      5,
    );

    await expect(fetchWithTimeout('https://provider.example', {})).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });

  test('clears the provider-headers deadline before consuming the response body', async () => {
    const providerSignals: AbortSignal[] = [];
    const fetchWithTimeout = withUpstreamHeadersTimeout(async (_input, init) => {
      if (init.signal) providerSignals.push(init.signal);
      return new Response(
        new ReadableStream({
          async start(controller) {
            await Bun.sleep(15);
            controller.enqueue(new TextEncoder().encode('late body'));
            controller.close();
          },
        }),
      );
    }, 5);

    const response = await fetchWithTimeout('https://provider.example', {});
    expect(await response.text()).toBe('late body');
    expect(providerSignals[0]?.aborted).toBe(false);
  });

  test('keeps client cancellation attached after provider headers arrive', async () => {
    const client = new AbortController();
    const providerSignals: AbortSignal[] = [];
    const fetchWithTimeout = withUpstreamHeadersTimeout(async (_input, init) => {
      if (init.signal) providerSignals.push(init.signal);
      return new Response('stream');
    }, 50);

    await fetchWithTimeout('https://provider.example', {
      signal: client.signal,
    });
    client.abort('client left');
    expect(providerSignals[0]?.aborted).toBe(true);
    expect(providerSignals[0]?.reason).toBe('client left');
  });

  // AI SDK streams answer the client with synthetic headers, so a large prefill
  // may wait on the provider's headers for five minutes; a direct request, whose
  // headers ARE the provider's, keeps the short budget.
  test.each([
    ['an AI SDK stream', { stream: true }, bedrock('anthropic.claude'), true, 5 * 60_000],
    ['a direct stream', { stream: true }, base, true, UPSTREAM_HEADERS_TIMEOUT_MS],
    ['a non-streaming AI SDK request', { stream: false }, bedrock('anthropic.claude'), false, UPSTREAM_HEADERS_TIMEOUT_MS],
  ])('%s gets its header budget', (_name, body, descriptor, streaming, expected) => {
    expect(upstreamHeadersTimeoutMs(body, descriptor, streaming)).toBe(expected);
  });
});
