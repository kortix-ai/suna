import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { runWithContext } from '../lib/request-context';

const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const PROJECT_ID = '00000000-0000-4000-a000-000000000201';
const SESSION_ID = '00000000-0000-4000-a000-000000000301';
const USER_ID = '00000000-0000-4000-a000-000000000401';

let projectSecretValue: string | null = 'sk-project-openrouter';
let creditCheck = { hasCredits: true, message: 'OK', balance: 100 };
let lastSecretLookup: { projectId: string; name: string } | null = null;
let lastProxyCall: {
  body: Record<string, unknown>;
  isStreaming: boolean;
  apiKey?: string;
  traceHeaders?: Record<string, string>;
} | null = null;
let lastDeductCall: unknown[] | null = null;
let usageEvents: Array<Record<string, unknown>> = [];

mock.module('../config', () => ({
  config: {
    DATABASE_URL: '',
    API_KEY_SECRET: 'session-llm-test-secret',
    KORTIX_LLM_ROUTER_REQS_PER_MIN_FREE: 100,
    KORTIX_LLM_ROUTER_REQS_PER_MIN_PAID: 1000,
  },
}));

mock.module('../projects/secrets', () => ({
  getProjectSecretValue: async (projectId: string, name: string) => {
    lastSecretLookup = { projectId, name };
    return projectSecretValue;
  },
}));

mock.module('../router/services/billing', () => ({
  checkCredits: async () => creditCheck,
  deductLLMCredits: async (...args: unknown[]) => {
    lastDeductCall = args;
    return { success: true };
  },
}));

mock.module('../shared/usage-events', () => ({
  recordUsageEvent: async (input: Record<string, unknown>) => {
    usageEvents.push(input);
  },
}));

mock.module('../router/services/llm', () => ({
  proxyToOpenRouter: async (
    body: Record<string, unknown>,
    isStreaming: boolean,
    apiKey?: string,
    traceHeaders?: Record<string, string>,
  ) => {
    lastProxyCall = { body, isStreaming, apiKey, traceHeaders };
    if (isStreaming) {
      return new Response(
        [
          'data: {"id":"chunk-1","choices":[{"delta":{"content":"ok"}}]}',
          'data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
          'data: [DONE]',
          '',
        ].join('\n'),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      );
    }
    return new Response(JSON.stringify({
      id: 'chatcmpl-session-test',
      object: 'chat.completion',
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  },
  extractUsage: (responseBody: any) => ({
    promptTokens: responseBody.usage?.prompt_tokens ?? 0,
    completionTokens: responseBody.usage?.completion_tokens ?? 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
  }),
  calculateCost: () => 0.001,
  getModel: (id: string) => ({
    openrouterId: id,
    inputPer1M: 1,
    outputPer1M: 2,
    contextWindow: 128000,
    tier: 'free',
  }),
  getAllModels: () => [
    {
      id: 'anthropic/claude-sonnet-4-5',
      owned_by: 'anthropic',
      context_window: 200000,
      pricing: { input: 3, output: 15 },
      tier: 'free',
    },
  ],
}));

const { sessionLlm } = await import('../router/routes/session-llm');
const { encodeSessionLlmToken } = await import('../shared/session-llm-token');
const { resetRateLimiters } = await import('../shared/rate-limit');

function createApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    await runWithContext(c.req.method, c.req.path, async () => {
      await next();
    }, c.req.header('traceparent'));
  });
  app.route('/v1/router/llm', sessionLlm);
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: true, message: err.message, status: err.status }, err.status);
    }
    return c.json({ error: true, message: (err as Error).message }, 500);
  });
  return app;
}

function token(ttlSeconds = 60) {
  return encodeSessionLlmToken({
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    userId: USER_ID,
    ttlSeconds,
  });
}

beforeEach(() => {
  resetRateLimiters();
  delete process.env.OPENROUTER_API_KEY;
  projectSecretValue = 'sk-project-openrouter';
  creditCheck = { hasCredits: true, message: 'OK', balance: 100 };
  lastSecretLookup = null;
  lastProxyCall = null;
  lastDeductCall = null;
  usageEvents = [];
});

describe('session-scoped LLM router', () => {
  test('rejects missing and invalid session tokens', async () => {
    const app = createApp();

    const missing = await app.request('/v1/router/llm/models');
    expect(missing.status).toBe(401);

    const invalid = await app.request('/v1/router/llm/models', {
      headers: { Authorization: 'Bearer not.a-valid-token' },
    });
    expect(invalid.status).toBe(401);
  });

  test('rejects expired session tokens', async () => {
    const app = createApp();
    const res = await app.request('/v1/router/llm/models', {
      headers: { Authorization: `Bearer ${token(-1)}` },
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.message).toContain('expired');
  });

  test('returns models for a valid session token', async () => {
    const app = createApp();
    const res = await app.request('/v1/router/llm/models', {
      headers: { Authorization: `Bearer ${token()}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('list');
    expect(body.data[0].id).toBe('anthropic/claude-sonnet-4-5');
  });

  test('proxies chat with the project secret instead of exposing provider keys to the sandbox', async () => {
    const app = createApp();
    const res = await app.request('/v1/router/llm/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(lastSecretLookup).toEqual({
      projectId: PROJECT_ID,
      name: 'OPENROUTER_API_KEY',
    });
    expect(lastProxyCall?.apiKey).toBe('sk-project-openrouter');
    expect(lastProxyCall?.body.model).toBe('anthropic/claude-sonnet-4-5');
    expect(lastDeductCall?.[0]).toBe(ACCOUNT_ID);
    expect(lastDeductCall?.[5]).toBe(SESSION_ID);
    expect(usageEvents[0]).toMatchObject({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      actorUserId: USER_ID,
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4-5',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
      streaming: false,
      upstreamStatus: 200,
    });
  });

  test('falls back to process OPENROUTER_API_KEY only when no project secret exists', async () => {
    projectSecretValue = null;
    process.env.OPENROUTER_API_KEY = 'sk-env-openrouter';

    const app = createApp();
    const res = await app.request('/v1/router/llm/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(lastProxyCall?.apiKey).toBe('sk-env-openrouter');
  });

  test('propagates trace headers to the upstream LLM provider', async () => {
    const app = createApp();
    const res = await app.request('/v1/router/llm/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token()}`,
        'Content-Type': 'application/json',
        traceparent: '00-33333333333333333333333333333333-4444444444444444-01',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(lastProxyCall?.traceHeaders?.traceparent).toMatch(/^00-33333333333333333333333333333333-[0-9a-f]{16}-01$/);
    expect(lastProxyCall?.traceHeaders?.['X-Request-Id']).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
  });

  test('fails closed when no project or env provider key is configured', async () => {
    projectSecretValue = null;

    const app = createApp();
    const res = await app.request('/v1/router/llm/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(res.status).toBe(503);
    expect(lastProxyCall).toBeNull();
  });

  test('checks credits before proxying upstream', async () => {
    creditCheck = { hasCredits: false, message: 'No credits', balance: 0 };

    const app = createApp();
    const res = await app.request('/v1/router/llm/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(res.status).toBe(402);
    expect(lastProxyCall).toBeNull();
  });

  test('records usage events for streaming calls without buffering the client response', async () => {
    const app = createApp();
    const res = await app.request('/v1/router/llm/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-5',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    expect(await res.text()).toContain('data: [DONE]');

    await Bun.sleep(0);
    expect(lastDeductCall?.[0]).toBe(ACCOUNT_ID);
    expect(lastDeductCall?.[5]).toBe(SESSION_ID);
    expect(usageEvents[0]).toMatchObject({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      actorUserId: USER_ID,
      inputTokens: 10,
      outputTokens: 5,
      streaming: true,
    });
  });
});
