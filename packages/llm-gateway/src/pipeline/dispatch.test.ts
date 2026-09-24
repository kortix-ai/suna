import { describe, expect, test } from 'bun:test';
import type { UpstreamDescriptor } from '../domain';
import { ClientAbortError, UpstreamHttpError } from '../errors';
import { type DispatchContext, type DispatchPlan, type Send, dispatch } from './dispatch';

const base: UpstreamDescriptor = {
  provider: 'provider-a',
  kind: 'openai-compat',
  baseUrl: 'https://provider-a.example/v1',
  apiKey: 'key',
  billingMode: 'credits',
  markup: 1,
};

type Reply = Response | Error;
interface Sent {
  provider: string;
  key: string;
  model: unknown;
  resolvedModel?: string;
  body: Record<string, unknown>;
}

const ok = () => new Response('{"choices":[]}', { status: 200 });
const status = (code: number, headers?: Record<string, string>) =>
  new Response(`status ${code}`, { status: code, headers });
const profileRefusal = () =>
  new UpstreamHttpError(400, 'Invocation of model ID x with on-demand throughput isn’t supported.', 'amazon-bedrock');

function harness(reply: (sent: Sent, index: number) => Reply, overrides: Partial<DispatchContext> = {}) {
  const sent: Sent[] = [];
  const cooldowns: Array<[string, number]> = [];
  const resolved: string[] = [];
  const send: Send = async (body, descriptor) => {
    const entry = {
      provider: descriptor.provider,
      key: descriptor.apiKey,
      model: body.model,
      resolvedModel: descriptor.resolvedModel,
      body,
    };
    sent.push(entry);
    const result = reply(entry, sent.length - 1);
    if (result instanceof Error) throw result;
    return result;
  };
  const ctx: DispatchContext = {
    requestId: 'req_test',
    logger: { info() {}, warn() {}, error() {} },
    fetchImpl: async () => ok(),
    send,
    resolveCandidates: async (model) => {
      resolved.push(model);
      return [{ ...base, provider: `${model}-upstream` }];
    },
    notePoolRateLimit: async (secretId, seconds) => {
      cooldowns.push([secretId, seconds]);
    },
    ...overrides,
  };
  const run = (plan: DispatchPlan, body: Record<string, unknown> = { messages: [] }) => dispatch(body, plan, ctx);
  return { run, sent, cooldowns, resolved };
}

describe('dispatch: one attempt plan', () => {
  test('a single candidate is sent once and its answer returned unchanged', async () => {
    const { run, sent } = harness(() => status(503));
    const outcome = await run({ model: 'm', candidates: [base] });
    expect(sent).toHaveLength(1);
    expect(outcome.response?.status).toBe(503);
    expect(outcome).toMatchObject({ attempts: 1, candidatesTried: ['provider-a'], attemptFailures: [] });
  });

  test('a thrown final failure is returned as `error`', async () => {
    const failure = new TypeError('fetch failed');
    const { run } = harness(() => failure);
    const outcome = await run({ model: 'm', candidates: [base] });
    expect(outcome.response).toBeUndefined();
    expect(outcome.error).toBe(failure);
  });

  test('a pool key and its Bedrock inference profile compose', async () => {
    const key = (name: string): UpstreamDescriptor => ({
      ...base, provider: 'amazon-bedrock', kind: 'bedrock', apiKey: name, poolSecretId: name,
      billingMode: 'none', markup: 0, resolvedModel: 'xai.grok-4.6',
    });
    const { run, sent, cooldowns } = harness(({ key: apiKey, resolvedModel }) => {
      if (resolvedModel === 'xai.grok-4.6') return profileRefusal();
      if (apiKey === 'a') return new UpstreamHttpError(429, 'limited', 'amazon-bedrock', { 'retry-after': '5' });
      return ok();
    });
    const outcome = await run({ model: 'amazon-bedrock/xai.grok-4.6', candidates: [key('a'), key('b')] });
    expect(sent.map((s) => `${s.key}:${s.resolvedModel}`)).toEqual([
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
    const bedrock: UpstreamDescriptor = { ...base, provider: 'amazon-bedrock', kind: 'bedrock', resolvedModel: 'xai.grok-4.6' };
    const { run, sent } = harness(() => profileRefusal());
    const outcome = await run({ model: 'm', candidates: [bedrock] });
    expect(sent.map((s) => s.resolvedModel)).toEqual(['xai.grok-4.6', 'global.xai.grok-4.6', 'us.xai.grok-4.6']);
    expect(outcome.error).toBeInstanceOf(UpstreamHttpError);
  });

  test('a refused reasoning_effort is dropped once, for that attempt only', async () => {
    const bedrock: UpstreamDescriptor = { ...base, provider: 'amazon-bedrock', kind: 'bedrock', resolvedModel: 'openai.dispatch-effort' };
    const refusal = new UpstreamHttpError(400, 'unknown_parameter: reasoning_effort', 'amazon-bedrock');
    const { run, sent } = harness(() => refusal);
    const outcome = await run({ model: 'm', candidates: [bedrock] }, { messages: [], reasoning_effort: 'high' });
    expect(sent.map((s) => s.body.reasoning_effort)).toEqual(['high', undefined]);
    expect(outcome.error).toBe(refusal);
  });

  test('every pool key rate-limited returns a 429 carrying the earliest cooldown', async () => {
    const key = (name: string): UpstreamDescriptor => ({ ...base, apiKey: name, poolSecretId: name, billingMode: 'none', markup: 0 });
    const { run, cooldowns } = harness(({ key: apiKey }) =>
      new UpstreamHttpError(429, '{"error":"limited"}', 'provider-a', { 'retry-after': apiKey === 'a' ? '40' : '6' }));
    const outcome = await run({ model: 'm', candidates: [key('a'), key('b')] });
    expect(outcome.response?.status).toBe(429);
    expect(outcome.response?.headers.get('retry-after')).toBe('6');
    expect(await outcome.response?.text()).toBe('{"error":"limited"}');
    expect(cooldowns).toEqual([['a', 40], ['b', 6]]);
  });

  test('a pool key failing with anything but 429 is final', async () => {
    const key = (name: string): UpstreamDescriptor => ({ ...base, apiKey: name, poolSecretId: name, billingMode: 'none', markup: 0 });
    const { run, sent } = harness(() => status(401));
    const outcome = await run({ model: 'm', candidates: [key('a'), key('b')] });
    expect(sent).toHaveLength(1);
    expect(outcome.response?.status).toBe(401);
  });

  test('a failover chain skips candidates that did not opt in', async () => {
    const chain = [
      { ...base, provider: 'first', failover: true },
      { ...base, provider: 'no-opt-in' },
      { ...base, provider: 'third', failover: true },
    ];
    const { run, sent } = harness((s) => (s.provider === 'third' ? ok() : status(500)));
    const outcome = await run({ model: 'm', candidates: chain });
    expect(sent.map((s) => s.provider)).toEqual(['first', 'third']);
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

  test('each model gets its own generation defaults and the client value still wins', async () => {
    const { run, sent } = harness((_s, index) => (index === 0 ? status(502) : ok()));
    await run(
      {
        model: 'm',
        candidates: [base],
        fallbackModels: ['f'],
        defaultsFor: (model) => (model === 'm' ? { temperature: 0.9, maxOutputTokens: 100 } : { maxOutputTokens: 50 }),
      },
      { messages: [], top_p: 0.5 },
    );
    expect(sent.map((s) => [s.body.temperature, s.body.max_tokens, s.body.top_p])).toEqual([
      [0.9, 100, 0.5],
      [undefined, 50, 0.5],
    ]);
  });

  test('a transient chain stops at a request error; any-error moves past it', async () => {
    for (const [fallbackOn, expected] of [['transient', 1], ['any-error', 2]] as const) {
      const { run, sent } = harness(() => status(400));
      await run({ model: 'm', candidates: [base], fallbackModels: ['f'], fallbackOn });
      expect(sent).toHaveLength(expected);
    }
  });

  test('a transient chain moves past limit statuses, server errors, and network errors', async () => {
    for (const reply of [status(402), status(403), status(429), status(500), new TypeError('fetch failed')]) {
      const { run, sent } = harness((_s, index) => (index === 0 ? reply : ok()));
      const outcome = await run({ model: 'm', candidates: [base], fallbackModels: ['f'] });
      expect(sent).toHaveLength(2);
      expect(outcome.model).toBe('f');
    }
  });

  test('a BYOK primary skips Kortix-billed fallback candidates', async () => {
    const byok: UpstreamDescriptor = { ...base, billingMode: 'none', markup: 0 };
    const { run, sent } = harness(() => status(503), {
      resolveCandidates: async (model) => [
        { ...base, provider: `${model}-managed` },
        ...(model === 'g' ? [{ ...base, provider: 'g-byok', billingMode: 'none' as const, markup: 0 }] : []),
      ],
    });
    await run({ model: 'm', candidates: [byok], fallbackModels: ['f', 'g'] });
    expect(sent.map((s) => s.provider)).toEqual(['provider-a', 'g-byok']);
  });

  test('a client that left stops the plan', async () => {
    const { run, sent } = harness(() => new ClientAbortError());
    const outcome = await run({ model: 'm', candidates: [{ ...base, failover: true }, { ...base, failover: true }], fallbackModels: ['f'], fallbackOn: 'any-error' });
    expect(sent).toHaveLength(1);
    expect(outcome.error).toBeInstanceOf(ClientAbortError);
  });

  test('a publicly named candidate records a classified failure, never the upstream text', async () => {
    const managed = (provider: string): UpstreamDescriptor => ({ ...base, provider, failover: true, publicProvider: 'kortix' });
    const { run } = harness((s) => (s.provider === 'upstream-a' ? new Response('upstream-a key rejected', { status: 401 }) : ok()));
    const outcome = await run({ model: 'm', candidates: [managed('upstream-a'), managed('upstream-b')] });
    expect(outcome.attemptFailures).toEqual([
      expect.objectContaining({ provider: 'kortix', resolvedModel: 'm', code: 'model_unavailable', status: 401 }),
    ]);
    expect(JSON.stringify(outcome.attemptFailures)).not.toContain('upstream-a');
    expect(outcome.candidatesTried).toEqual(['kortix', 'kortix']);
  });
});
