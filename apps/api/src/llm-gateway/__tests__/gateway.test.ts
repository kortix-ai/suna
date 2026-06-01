import { describe, test, expect, beforeEach } from 'bun:test';
import { createLlmGateway } from '..';
import type { LlmGatewayConfig, LlmGatewayHooks, UsageEvent } from '../types';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

let fetchCalls: FetchCall[] = [];
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  fetchImpl = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = ((url: any, init?: any) => {
    fetchCalls.push({ url: String(url), init });
    return fetchImpl(String(url), init);
  }) as typeof fetch;
});

function makeHooks(overrides: Partial<LlmGatewayHooks> = {}): {
  hooks: LlmGatewayHooks;
  recorded: UsageEvent[];
} {
  const recorded: UsageEvent[] = [];
  const hooks: LlmGatewayHooks = {
    authenticateToken: overrides.authenticateToken ??
      (async (token) => (token === 'good' ? { userId: 'u1', accountId: 'a1' } : null)),
    assertBillingActive: overrides.assertBillingActive ?? (async () => {}),
    recordUsage: overrides.recordUsage ?? (async (e) => { recorded.push(e); }),
  };
  return { hooks, recorded };
}

const defaultConfig: LlmGatewayConfig = {
  enabled: true,
  openrouterApiKey: 'sk-or-test',
  baseUrl: 'https://test.openrouter.example/v1',
  markup: 1.2,
  appName: 'KortixTest',
};

function jsonReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://local.test/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('gateway — disabled state', () => {
  test('returns 503 on every route when disabled', async () => {
    const { hooks } = makeHooks();
    const app = createLlmGateway({ ...defaultConfig, enabled: false }, hooks);
    const res = await app.fetch(new Request('http://local.test/chat/completions', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(503);
    const body = await res.json() as any;
    expect(body.error).toContain('disabled');
  });

  test('returns 500 when openrouter key is missing', async () => {
    const { hooks } = makeHooks();
    const app = createLlmGateway({ ...defaultConfig, openrouterApiKey: '' }, hooks);
    const res = await app.fetch(new Request('http://local.test/chat/completions', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(500);
  });
});

describe('gateway — auth', () => {
  test('401 on missing bearer', async () => {
    const { hooks } = makeHooks();
    const app = createLlmGateway(defaultConfig, hooks);
    const res = await app.fetch(jsonReq({ model: 'm', messages: [] }));
    expect(res.status).toBe(401);
  });

  test('401 on invalid token', async () => {
    const { hooks } = makeHooks();
    const app = createLlmGateway(defaultConfig, hooks);
    const res = await app.fetch(jsonReq({ model: 'm', messages: [] }, { Authorization: 'Bearer bad' }));
    expect(res.status).toBe(401);
  });
});

describe('gateway — billing gate', () => {
  test('402 with structured body when billing inactive', async () => {
    const { hooks } = makeHooks({
      assertBillingActive: async () => {
        throw new Error('Subscribe to activate your seat.');
      },
    });
    const app = createLlmGateway(defaultConfig, hooks);
    const res = await app.fetch(jsonReq({ model: 'm', messages: [] }, { Authorization: 'Bearer good' }));
    expect(res.status).toBe(402);
    const body = await res.json() as any;
    expect(body.code).toBe('subscription_required');
    expect(body.message).toContain('Subscribe');
  });
});

describe('gateway — happy path (non-streaming)', () => {
  test('proxies to upstream with auth + records usage', async () => {
    fetchImpl = async () =>
      new Response(
        JSON.stringify({
          model: 'openai/gpt-4o-mini',
          choices: [{ message: { role: 'assistant', content: 'hi' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const { hooks, recorded } = makeHooks();
    const app = createLlmGateway(defaultConfig, hooks);

    const res = await app.fetch(
      jsonReq(
        { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
        { Authorization: 'Bearer good' },
      ),
    );

    expect(res.status).toBe(200);

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toBe('https://test.openrouter.example/v1/chat/completions');
    const headers = new Headers(fetchCalls[0].init?.headers);
    expect(headers.get('authorization')).toBe('Bearer sk-or-test');
    expect(headers.get('x-title')).toBe('KortixTest');

    await new Promise((r) => setTimeout(r, 5));
    expect(recorded.length).toBe(1);
    const event = recorded[0];
    expect(event.accountId).toBe('a1');
    expect(event.actorUserId).toBe('u1');
    expect(event.provider).toBe('openrouter');
    expect(event.model).toBe('openai/gpt-4o-mini');
    expect(event.promptTokens).toBe(10);
    expect(event.completionTokens).toBe(5);
    expect(event.upstreamCost).toBeCloseTo(0.0001, 6);
    expect(event.finalCost).toBeCloseTo(0.0001 * 1.2, 6);
    expect(event.streaming).toBe(false);
  });
});

describe('gateway — reasoning injection', () => {
  test('injects reasoning.effort=medium for reasoning-capable Anthropic models', async () => {
    fetchImpl = async () =>
      new Response(JSON.stringify({ choices: [], usage: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const { hooks } = makeHooks();
    const app = createLlmGateway(defaultConfig, hooks);
    await app.fetch(
      jsonReq(
        { model: 'anthropic/claude-sonnet-4.6', messages: [{ role: 'user', content: 'hi' }] },
        { Authorization: 'Bearer good' },
      ),
    );
    const sent = JSON.parse(fetchCalls[0].init?.body as string);
    expect(sent.reasoning).toEqual({ effort: 'medium' });
  });

  test('does NOT inject reasoning for non-reasoning models (gpt-4o)', async () => {
    fetchImpl = async () =>
      new Response(JSON.stringify({ choices: [], usage: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const { hooks } = makeHooks();
    const app = createLlmGateway(defaultConfig, hooks);
    await app.fetch(
      jsonReq(
        { model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
        { Authorization: 'Bearer good' },
      ),
    );
    const sent = JSON.parse(fetchCalls[0].init?.body as string);
    expect(sent.reasoning).toBeUndefined();
    expect(sent.reasoning_effort).toBeUndefined();
  });

  test('respects caller-supplied reasoning_effort (does not overwrite)', async () => {
    fetchImpl = async () =>
      new Response(JSON.stringify({ choices: [], usage: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const { hooks } = makeHooks();
    const app = createLlmGateway(defaultConfig, hooks);
    await app.fetch(
      jsonReq(
        {
          model: 'anthropic/claude-opus-4.8',
          messages: [{ role: 'user', content: 'hi' }],
          reasoning_effort: 'high',
        },
        { Authorization: 'Bearer good' },
      ),
    );
    const sent = JSON.parse(fetchCalls[0].init?.body as string);
    expect(sent.reasoning_effort).toBe('high');
    expect(sent.reasoning).toBeUndefined();
  });
});

describe('gateway — upstream errors', () => {
  test('propagates upstream non-2xx status', async () => {
    fetchImpl = async () =>
      new Response('rate limited', { status: 429 });
    const { hooks } = makeHooks();
    const app = createLlmGateway(defaultConfig, hooks);
    const res = await app.fetch(
      jsonReq({ model: 'm', messages: [] }, { Authorization: 'Bearer good' }),
    );
    expect(res.status).toBe(429);
  });
});

describe('gateway — body validation', () => {
  test('400 on non-JSON body', async () => {
    const { hooks } = makeHooks();
    const app = createLlmGateway(defaultConfig, hooks);
    const res = await app.fetch(
      new Request('http://local.test/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer good' },
        body: 'not json',
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('gateway — health + models', () => {
  test('GET /health reports config snapshot', async () => {
    const { hooks } = makeHooks();
    const app = createLlmGateway(defaultConfig, hooks);
    const res = await app.fetch(new Request('http://local.test/health'));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.markup).toBe(1.2);
    expect(body.keyConfigured).toBe(true);
  });

  test('GET /models proxies to upstream catalog', async () => {
    fetchImpl = async () =>
      new Response(JSON.stringify({ data: [{ id: 'x/y' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const { hooks } = makeHooks();
    const app = createLlmGateway(defaultConfig, hooks);
    const res = await app.fetch(new Request('http://local.test/models'));
    expect(res.status).toBe(200);
    expect(fetchCalls[0].url).toBe('https://test.openrouter.example/v1/models');
  });
});

afterAllRestoreFetch();

function afterAllRestoreFetch() {
  if (typeof globalThis.fetch !== 'function') return;
  process.on('beforeExit', () => {
    globalThis.fetch = originalFetch;
  });
}
