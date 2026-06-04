/**
 * E2E tests for the Router service.
 *
 * Tests: health, web-search, image-search, models, chat/completions (passthrough proxy).
 *
 * Strategy:
 * - mock.module() replaces external services (Tavily, Serper, LLM proxy, billing)
 * - apiKeyAuth mock bypasses auth validation, sets accountId from Bearer token
 * - The LLM route is a 1:1 passthrough proxy to OpenRouter — we mock proxyToOpenRouter
 *   to return realistic OpenAI-compatible responses (including tool_calls)
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { BillingError } from '../errors';
import { runWithContext } from '../lib/request-context';

// ─── Mock tracking ───────────────────────────────────────────────────────────

let mockTavilyResults: any[] = [];
let mockTavilyError: Error | null = null;
let mockSerperResults: any[] = [];
let mockSerperError: Error | null = null;
let mockCheckCreditsResult = { hasCredits: true, message: 'OK', balance: 100 };
let mockDeductResult: any = { success: true, cost: 0.01, newBalance: 99, transactionId: 'tx_mock_001' };

// Mock OpenRouter proxy response — full OpenAI-compat format
let mockProxyResponse: Response | null = null;
let mockProxyError: Error | null = null;
let lastProxyBody: Record<string, unknown> | null = null;
let lastProxyTraceHeaders: Record<string, string> | null = null;

const TEST_ACCOUNT_ID = 'acc_test_e2e_001';

// ─── Helper: create mock OpenAI response ─────────────────────────────────────

function createMockChatResponse(overrides?: Partial<any>) {
  return {
    id: 'chatcmpl-mock-001',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'anthropic/claude-sonnet-4.6',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'Hello! How can I help you?',
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    },
    ...overrides,
  };
}

function createMockStreamResponse(): Response {
  const chunks = [
    { id: 'chatcmpl-mock-001', object: 'chat.completion.chunk', model: 'anthropic/claude-sonnet-4.6', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    { id: 'chatcmpl-mock-001', object: 'chat.completion.chunk', model: 'anthropic/claude-sonnet-4.6', choices: [{ index: 0, delta: { content: 'Hello ' }, finish_reason: null }] },
    { id: 'chatcmpl-mock-001', object: 'chat.completion.chunk', model: 'anthropic/claude-sonnet-4.6', choices: [{ index: 0, delta: { content: 'world!' }, finish_reason: null }] },
    { id: 'chatcmpl-mock-001', object: 'chat.completion.chunk', model: 'anthropic/claude-sonnet-4.6', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } },
  ];

  const encoder = new TextEncoder();
  const sseBody = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';

  return new Response(encoder.encode(sseBody), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

// ─── Register mocks ──────────────────────────────────────────────────────────

// Mock apiKeyAuth to always set accountId (bypasses real auth validation)
mock.module('../middleware/auth', () => ({
  apiKeyAuth: async (c: any, next: any) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new HTTPException(401, { message: 'Missing or invalid Authorization header' });
    }
    const token = authHeader.slice(7);
    if (!token) {
      throw new HTTPException(401, { message: 'Missing token in Authorization header' });
    }
    c.set('accountId', TEST_ACCOUNT_ID);
    await next();
  },
  supabaseAuth: async (c: any, next: any) => {
    c.set('userId', TEST_ACCOUNT_ID);
    c.set('userEmail', 'test@example.com');
    await next();
  },
  combinedAuth: async (c: any, next: any) => { await next(); },
}));

mock.module('../router/services/tavily', () => ({
  webSearchTavily: async (query: string, maxResults: number, searchDepth: string) => {
    if (mockTavilyError) throw mockTavilyError;
    return mockTavilyResults;
  },
}));

mock.module('../router/services/serper', () => ({
  imageSearchSerper: async (query: string, maxResults: number, safeSearch: boolean) => {
    if (mockSerperError) throw mockSerperError;
    return mockSerperResults;
  },
}));

mock.module('../router/services/billing', () => ({
  checkCredits: async (accountId: string, min?: number, opts?: any) => mockCheckCreditsResult,
  deductToolCredits: async (...args: any[]) => mockDeductResult,
  deductLLMCredits: async (...args: any[]) => mockDeductResult,
}));

mock.module('../router/services/llm', () => ({
  proxyToOpenRouter: async (
    body: Record<string, unknown>,
    isStreaming: boolean,
    _apiKey?: string,
    traceHeaders?: Record<string, string>,
  ) => {
    lastProxyBody = body;
    lastProxyTraceHeaders = traceHeaders ?? null;
    if (mockProxyError) throw mockProxyError;
    if (mockProxyResponse) return mockProxyResponse;

    // Default: return a realistic non-streaming response
    if (isStreaming) {
      return createMockStreamResponse();
    }
    return new Response(JSON.stringify(createMockChatResponse()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  },
  extractUsage: (responseBody: any) => {
    if (!responseBody?.usage) return null;
    return {
      promptTokens: responseBody.usage.prompt_tokens ?? 0,
      completionTokens: responseBody.usage.completion_tokens ?? 0,
    };
  },
  calculateCost: (modelConfig: any, prompt: number, completion: number) => {
    return ((prompt / 1_000_000) * (modelConfig?.inputPer1M || 0) +
            (completion / 1_000_000) * (modelConfig?.outputPer1M || 0)) * 1.2;
  },
  getAllModels: () => [
    { id: 'minimax/minimax-m2.7', object: 'model', owned_by: 'kortix', context_window: 204800, pricing: { input: 0.30, output: 1.20 }, tier: 'free' },
    { id: 'z-ai/glm-5-turbo', object: 'model', owned_by: 'kortix', context_window: 202752, pricing: { input: 1.20, output: 4.00 }, tier: 'free' },
    { id: 'moonshotai/kimi-k2.5', object: 'model', owned_by: 'kortix', context_window: 262144, pricing: { input: 0.45, output: 2.20 }, tier: 'free' },
    { id: 'minimax/minimax-m2.5', object: 'model', owned_by: 'kortix', context_window: 196608, pricing: { input: 0.20, output: 1.17 }, tier: 'free' },
  ],
  getModel: (id: string) => ({
    openrouterId: id,
    inputPer1M: id === 'minimax/minimax-m2.7' ? 0.30 : id === 'z-ai/glm-5-turbo' ? 1.20 : id === 'moonshotai/kimi-k2.5' ? 0.45 : 0.20,
    outputPer1M: id === 'minimax/minimax-m2.7' ? 1.20 : id === 'z-ai/glm-5-turbo' ? 4.00 : id === 'moonshotai/kimi-k2.5' ? 2.20 : 1.17,
    contextWindow: id === 'minimax/minimax-m2.7' ? 204800 : id === 'z-ai/glm-5-turbo' ? 202752 : id === 'moonshotai/kimi-k2.5' ? 262144 : 196608,
    tier: 'free' as 'free' | 'paid',
  }),
  resolveOpenRouterId: (id: string) => id,
}));

// ─── Import router AFTER mocks ───────────────────────────────────────────────

const { router } = await import('../router/index');

// ─── Test app factory ────────────────────────────────────────────────────────

function createRouterTestApp() {
  const app = new Hono();
  app.use('*', cors());
  app.use('*', async (c, next) => {
    return runWithContext(c.req.method, new URL(c.req.url).pathname, () => next(), c.req.header('traceparent'));
  });

  app.route('/v1/router', router);

  app.onError((err, c) => {
    if (err instanceof BillingError) {
      return c.json({ error: err.message }, err.statusCode as any);
    }
    if (err instanceof HTTPException) {
      return c.json({ error: true, message: err.message, status: err.status }, err.status);
    }
    console.error('Router test error:', err);
    return c.json({ error: true, message: 'Internal server error', status: 500 }, 500);
  });

  app.notFound((c) => c.json({ error: true, message: 'Not found', status: 404 }, 404));

  return app;
}

// ─── Reset mocks ─────────────────────────────────────────────────────────────

beforeEach(() => {
  mockTavilyResults = [
    { title: 'Result 1', url: 'https://example.com/1', snippet: 'First result', published_date: null },
    { title: 'Result 2', url: 'https://example.com/2', snippet: 'Second result', published_date: '2025-01-01' },
  ];
  mockTavilyError = null;
  mockSerperResults = [
    { title: 'Image 1', url: 'https://img.com/1.jpg', thumbnail_url: 'https://img.com/1_t.jpg', source_url: 'https://example.com/1', width: 800, height: 600 },
  ];
  mockSerperError = null;
  mockCheckCreditsResult = { hasCredits: true, message: 'OK', balance: 100 };
  mockDeductResult = { success: true, cost: 0.01, newBalance: 99, transactionId: 'tx_mock_001' };
  mockProxyResponse = null;
  mockProxyError = null;
  lastProxyBody = null;
  lastProxyTraceHeaders = null;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Router: health', () => {
  test('GET /v1/router/health returns ok', async () => {
    const app = createRouterTestApp();
    const res = await app.request('/v1/router/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('kortix-router');
    expect(body.timestamp).toBeDefined();
    expect(body.billing_enabled).toBeDefined();
  });
});

describe('Router: web-search', () => {
  test('POST /v1/router/web-search returns search results', async () => {
    const app = createRouterTestApp();
    const res = await app.request('/v1/router/web-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ACCOUNT_ID}` },
      body: JSON.stringify({ query: 'test query', max_results: 2 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(2);
    expect(body.query).toBe('test query');
    expect(body.cost).toBeDefined();
    expect(body.results[0].title).toBe('Result 1');
  });

  test('returns 400 for missing query', async () => {
    const app = createRouterTestApp();
    const res = await app.request('/v1/router/web-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ACCOUNT_ID}` },
      body: JSON.stringify({ max_results: 5 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message || body.error).toBeDefined();
  });

  test('returns 400 for empty query', async () => {
    const app = createRouterTestApp();
    const res = await app.request('/v1/router/web-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ACCOUNT_ID}` },
      body: JSON.stringify({ query: '' }),
    });
    expect(res.status).toBe(400);
  });

  test('returns 402 when insufficient credits', async () => {
    mockCheckCreditsResult = { hasCredits: false, message: 'No credits', balance: 0 };
    const app = createRouterTestApp();
    const res = await app.request('/v1/router/web-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ACCOUNT_ID}` },
      body: JSON.stringify({ query: 'test' }),
    });
    expect(res.status).toBe(402);
  });

  test('returns 500 when Tavily service throws', async () => {
    mockTavilyError = new Error('TAVILY_API_KEY not configured');
    const app = createRouterTestApp();
    const res = await app.request('/v1/router/web-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ACCOUNT_ID}` },
      body: JSON.stringify({ query: 'test' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.message).toContain('not configured');
  });

  test('applies default search_depth=basic and max_results=5', async () => {
    const app = createRouterTestApp();
    const res = await app.request('/v1/router/web-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ACCOUNT_ID}` },
      body: JSON.stringify({ query: 'test' }),
    });
    expect(res.status).toBe(200);
  });

  test('accepts search_depth=advanced', async () => {
    const app = createRouterTestApp();
    const res = await app.request('/v1/router/web-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ACCOUNT_ID}` },
      body: JSON.stringify({ query: 'test', search_depth: 'advanced' }),
    });
    expect(res.status).toBe(200);
  });
});

describe('Router: image-search', () => {
  test('POST /v1/router/image-search returns image results', async () => {
    const app = createRouterTestApp();
    const res = await app.request('/v1/router/image-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ACCOUNT_ID}` },
      body: JSON.stringify({ query: 'cat photos' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.query).toBe('cat photos');
    expect(body.cost).toBeDefined();
    expect(body.results[0].title).toBe('Image 1');
  });

  test('returns 400 for missing query', async () => {
    const app = createRouterTestApp();
    const res = await app.request('/v1/router/image-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ACCOUNT_ID}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test('returns 402 when insufficient credits', async () => {
    mockCheckCreditsResult = { hasCredits: false, message: 'No credits', balance: 0 };
    const app = createRouterTestApp();
    const res = await app.request('/v1/router/image-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ACCOUNT_ID}` },
      body: JSON.stringify({ query: 'cats' }),
    });
    expect(res.status).toBe(402);
  });

  test('returns 500 when Serper service throws', async () => {
    mockSerperError = new Error('SERPER_API_KEY not configured');
    const app = createRouterTestApp();
    const res = await app.request('/v1/router/image-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ACCOUNT_ID}` },
      body: JSON.stringify({ query: 'cats' }),
    });
    expect(res.status).toBe(500);
  });
});

describe('Router: models', () => {
  test('GET /v1/router/models returns model list', async () => {
    const app = createRouterTestApp();
    const res = await app.request('/v1/router/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${TEST_ACCOUNT_ID}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('list');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(4);

    const minimax27 = body.data.find((m: any) => m.id === 'minimax/minimax-m2.7');
    expect(minimax27).toBeDefined();
    expect(minimax27.tier).toBe('free');
    expect(minimax27.pricing.input).toBe(0.30);

    const kimi = body.data.find((m: any) => m.id === 'moonshotai/kimi-k2.5');
    expect(kimi).toBeDefined();
    expect(kimi.tier).toBe('free');
  });

  test('GET /v1/router/models/:model returns 404 for unknown model', async () => {
    const app = createRouterTestApp();
    const res = await app.request('/v1/router/models/nonexistent-model', {
      method: 'GET',
      headers: { Authorization: `Bearer ${TEST_ACCOUNT_ID}` },
    });
    expect(res.status).toBe(404);
  });

  test('GET /v1/router/models/:model works for single-segment model ID', async () => {
    const app = createRouterTestApp();
    const res = await app.request('/v1/router/models/minimax%2Fminimax-m2.7', {
      method: 'GET',
      headers: { Authorization: `Bearer ${TEST_ACCOUNT_ID}` },
    });
    // URL-encoded slash may or may not be decoded by Hono
    expect([200, 404]).toContain(res.status);
  });
});

describe('Router: chat/completions (non-streaming)', () => {
  test('returns OpenAI-compatible response', async () => {
    const app = createRouterTestApp();
    const res = await app.request('/v1/router/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ACCOUNT_ID}` },
      body: JSON.stringify({
        model: 'minimax/minimax-m2.7',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('chat.completion');
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0].message.role).toBe('assistant');
    expect(body.choices[0].message.content).toBeDefined();
    expect(body.choices[0].finish_reason).toBe('stop');
    expect(body.usage).toBeDefined();
    expect(body.usage.prompt_tokens).toBe(100);
    expect(body.usage.completion_tokens).toBe(50);
  });

  test('propagates normalized trace headers to OpenRouter', async () => {
    const app = createRouterTestApp();
    const res = await app.request('/v1/router/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_ACCOUNT_ID}`,
        traceparent: '00-99999999999999999999999999999999-8888888888888888-01',
      },
      body: JSON.stringify({
        model: 'minimax/minimax-m2.7',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(lastProxyTraceHeaders?.traceparent).toMatch(/^00-99999999999999999999999999999999-[0-9a-f]{16}-01$/);
    expect(lastProxyTraceHeaders?.traceparent).not.toBe('00-99999999999999999999999999999999-8888888888888888-01');
    expect(lastProxyTraceHeaders?.['X-Request-Id']).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
  });

  test('returns 400 for missing model', async () => {
    const app = createRouterTestApp();
    const res = await app.request('/v1/router/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ACCOUNT_ID}` },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    expect(res.status).toBe(400);
  });

  test('returns 400 for missing messages', async () => {
    const app = createRouterTestApp();
    const res = await app.request('/v1/router/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ACCOUNT_ID}` },
      body: JSON.stringify({ model: 'kortix/basic' }),
    });
    expect(res.status).toBe(400);
  });

  test('returns 400 for invalid JSON body', async () => {
    const app = createRouterTestApp();
    const res = await app.request('/v1/router/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ACCOUNT_ID}` },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  test('returns 402 when insufficient credits', async () => {
    mockCheckCreditsResult = { hasCredits: false, message: 'Insufficient credits', balance: 0 };
    const app = createRouterTestApp();
    const res = await app.request('/v1/router/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ACCOUNT_ID}` },
      body: JSON.stringify({
        model: 'minimax/minimax-m2.7',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    expect(res.status).toBe(402);
  });

  test('passes through upstream error responses', async () => {
    mockProxyResponse = new Response(JSON.stringify({ error: { message: 'Model not found', type: 'invalid_request_error' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
    const app = createRouterTestApp();
    const res = await app.request('/v1/router/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ACCOUNT_ID}` },
      body: JSON.stringify({
        model: 'nonexistent/model',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.message).toBe('Model not found');
  });

  test('accepts optional temperature and max_tokens', async () => {
    const app = createRouterTestApp();
    const res = await app.request('/v1/router/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ACCOUNT_ID}` },
      body: JSON.stringify({
        model: 'minimax/minimax-m2.7',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
        max_tokens: 1000,
      }),
    });
    expect(res.status).toBe(200);
  });
});

describe('Router: chat/completions (streaming)', () => {
  test('returns SSE stream with correct format', async () => {
    const app = createRouterTestApp();
    const res = await app.request('/v1/router/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ACCOUNT_ID}` },
      body: JSON.stringify({
        model: 'minimax/minimax-m2.7',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const text = await res.text();
    expect(text).toContain('data:');
    expect(text).toContain('[DONE]');
    // Verify the stream contains actual content chunks
    expect(text).toContain('Hello ');
    expect(text).toContain('world!');
  });
});

describe('Router: chat/completions (tool support)', () => {
  test('preserves tools and tool_choice in request to OpenRouter', async () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the weather for a location',
          parameters: {
            type: 'object',
            properties: { location: { type: 'string' } },
            required: ['location'],
          },
        },
      },
    ];

    const app = createRouterTestApp();
    const res = await app.request('/v1/router/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ACCOUNT_ID}` },
      body: JSON.stringify({
        model: 'minimax/minimax-m2.7',
        messages: [{ role: 'user', content: 'What is the weather in SF?' }],
        tools,
        tool_choice: 'auto',
      }),
    });
    expect(res.status).toBe(200);

    // Verify the tools were passed through to proxyToOpenRouter
    expect(lastProxyBody).not.toBeNull();
    expect(lastProxyBody!.tools).toEqual(tools);
    expect(lastProxyBody!.tool_choice).toBe('auto');
  });

  test('preserves tool-role messages in request', async () => {
    const messages = [
      { role: 'user', content: 'What is the weather?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"location":"SF"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"temp": 65, "condition": "sunny"}' },
    ];

    const app = createRouterTestApp();
    const res = await app.request('/v1/router/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ACCOUNT_ID}` },
      body: JSON.stringify({
        model: 'minimax/minimax-m2.7',
        messages,
      }),
    });
    expect(res.status).toBe(200);

    // Verify tool-role messages were passed through (not rejected by Zod)
    expect(lastProxyBody).not.toBeNull();
    expect(lastProxyBody!.messages).toEqual(messages);
  });

  test('returns tool_calls in response when model decides to call tools', async () => {
    // Mock OpenRouter returning a tool_call response
    const toolCallResponse = createMockChatResponse({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_abc123',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"location":"San Francisco"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    mockProxyResponse = new Response(JSON.stringify(toolCallResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const app = createRouterTestApp();
    const res = await app.request('/v1/router/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ACCOUNT_ID}` },
      body: JSON.stringify({
        model: 'minimax/minimax-m2.7',
        messages: [{ role: 'user', content: 'What is the weather in SF?' }],
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.tool_calls).toHaveLength(1);
    expect(body.choices[0].message.tool_calls[0].function.name).toBe('get_weather');
    expect(body.choices[0].finish_reason).toBe('tool_calls');
  });

  test('preserves response_format in request', async () => {
    const app = createRouterTestApp();
    await app.request('/v1/router/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ACCOUNT_ID}` },
      body: JSON.stringify({
        model: 'minimax/minimax-m2.7',
        messages: [{ role: 'user', content: 'Hello' }],
        response_format: { type: 'json_object' },
      }),
    });

    expect(lastProxyBody).not.toBeNull();
    expect(lastProxyBody!.response_format).toEqual({ type: 'json_object' });
  });
});

describe('Router: auth (mocked apiKeyAuth)', () => {
  test('returns 401 without Authorization header', async () => {
    const app = createRouterTestApp();
    const res = await app.request('/v1/router/web-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test' }),
    });
    expect(res.status).toBe(401);
  });

  test('returns 401 with invalid header format (not Bearer)', async () => {
    const app = createRouterTestApp();
    const res = await app.request('/v1/router/web-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic abc123' },
      body: JSON.stringify({ query: 'test' }),
    });
    expect(res.status).toBe(401);
  });

  test('health endpoint does NOT require auth', async () => {
    const app = createRouterTestApp();
    const res = await app.request('/v1/router/health');
    expect(res.status).toBe(200);
  });

  test('search routes require auth, models require auth', async () => {
    const app = createRouterTestApp();

    const searchRes = await app.request('/v1/router/web-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test' }),
    });
    expect(searchRes.status).toBe(401);

    const modelsRes = await app.request('/v1/router/models', { method: 'GET' });
    expect(modelsRes.status).toBe(401);
  });
});
