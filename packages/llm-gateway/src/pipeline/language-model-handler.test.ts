import { describe, expect, it } from 'bun:test';
import { createGateway } from '../create-gateway';
import type { AuthedPrincipal, GatewayHooks, UpstreamDescriptor, UsageEvent } from '../domain';

// A complete Anthropic streaming SSE body: one text delta + input/output usage.
// Shaped exactly as @ai-sdk/anthropic's doStream parses it, so real `streamText`
// (driven by the native handler) yields a `text-delta` + a `finish` with usage.
function anthropicSse(text: string, inputTokens: number, outputTokens: number): Response {
  const body =
    `event: message_start\n` +
    `data: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 1 },
      },
    })}\n\n` +
    `event: content_block_start\n` +
    `data: ${JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    })}\n\n` +
    `event: content_block_delta\n` +
    `data: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    })}\n\n` +
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n` +
    `event: message_delta\n` +
    `data: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: outputTokens },
    })}\n\n` +
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function readStream(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  return out;
}

const PRINCIPAL: AuthedPrincipal = {
  accountId: 'acct_1',
  userId: 'user_1',
  projectId: 'proj_1',
  sessionId: 'sess_1',
  keyId: 'key_1',
};

function baseHooks(over: Partial<GatewayHooks> = {}): GatewayHooks {
  return {
    authenticate: async (token) => (token === 'good' ? PRINCIPAL : null),
    resolveUpstream: async () => [],
    assertBillingActive: async () => undefined,
    recordUsage: async () => undefined,
    ...over,
  };
}

const HEADERS = (over: Record<string, string | undefined> = {}) => ({
  authorization: 'Bearer good',
  'ai-language-model-specification-version': '"4"',
  'ai-language-model-id': 'anthropic/claude-fable-5',
  'ai-language-model-streaming': 'true',
  ...over,
});

function req(headers: Record<string, string | undefined>, body: unknown) {
  return {
    authorization: headers.authorization,
    header: (name: string) => headers[name.toLowerCase()] ?? headers[name],
    rawBody: JSON.stringify(body),
  };
}

const BODY = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };

describe('handleLanguageModel — flag gating', () => {
  it('is INERT (404) when the aiSdkNative flag is OFF — zero behavior change', async () => {
    const gateway = createGateway(baseHooks(), { aiSdkNative: false });
    const res = await gateway.languageModel(req(HEADERS(), BODY));
    expect(res.status).toBe(404);
    const data = (await res.json()) as { code?: string };
    expect(data.code).toBe('not_found');
  });

  it('is inert by DEFAULT (flag unset)', async () => {
    const gateway = createGateway(baseHooks(), {});
    const res = await gateway.languageModel(req(HEADERS(), BODY));
    expect(res.status).toBe(404);
  });
});

describe('handleLanguageModel — reuse of the auth/route gate (flag ON)', () => {
  it('rejects a missing bearer token with 401', async () => {
    const gateway = createGateway(baseHooks(), { aiSdkNative: true });
    const res = await gateway.languageModel({
      ...req(HEADERS({ authorization: undefined }), BODY),
      authorization: undefined,
    });
    expect(res.status).toBe(401);
  });

  it('rejects an invalid token with 401 (via admit)', async () => {
    const gateway = createGateway(baseHooks(), { aiSdkNative: true });
    const res = await gateway.languageModel(req(HEADERS({ authorization: 'Bearer bad' }), BODY));
    expect(res.status).toBe(401);
  });

  it('rejects a missing model-id header with 400 before touching billing', async () => {
    let billed = false;
    const gateway = createGateway(
      baseHooks({
        assertBillingActive: async () => {
          billed = true;
        },
      }),
      { aiSdkNative: true },
    );
    const res = await gateway.languageModel(
      req(HEADERS({ 'ai-language-model-id': undefined }), BODY),
    );
    expect(res.status).toBe(400);
    expect(billed).toBe(false);
  });

  it('returns model_unavailable (400) when no upstream resolves', async () => {
    const gateway = createGateway(baseHooks({ resolveUpstream: async () => [] }), {
      aiSdkNative: true,
    });
    const res = await gateway.languageModel(req(HEADERS(), BODY));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { code?: string };
    expect(data.code).toBe('model_unavailable');
  });

  it('reaches candidate dispatch when an upstream resolves (proves route reuse)', async () => {
    const descriptor: UpstreamDescriptor = {
      provider: 'anthropic',
      kind: 'anthropic',
      npm: '@ai-sdk/anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-test',
      resolvedModel: 'claude-fable-5',
      billingMode: 'credits',
      markup: 1,
    };
    let resolvedFor = '';
    const gateway = createGateway(
      baseHooks({
        resolveUpstream: async (_p, model) => {
          resolvedFor = model;
          return [descriptor];
        },
        // Fetch double: the provider package calls this; return a complete,
        // servable Anthropic SSE so the failover probe sees content and commits
        // the candidate (the handler now probes for content before committing).
      }),
      { aiSdkNative: true },
      {
        fetchImpl: async () => anthropicSse('ok', 3, 1),
      },
    );
    const res = await gateway.languageModel(req(HEADERS(), BODY));
    // Route resolution ran (candidate resolved) and the handler committed to a
    // 200 event-stream response (dispatch reached).
    expect(resolvedFor).toBe('anthropic/claude-fable-5');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });
});

describe('handleLanguageModel — per-turn failover + billing (flag ON)', () => {
  const descA: UpstreamDescriptor = {
    provider: 'anthropic',
    kind: 'anthropic',
    npm: '@ai-sdk/anthropic',
    baseUrl: 'https://a.example',
    apiKey: 'sk-a',
    resolvedModel: 'claude-a',
    billingMode: 'credits',
    markup: 1,
  };
  const descB: UpstreamDescriptor = {
    provider: 'anthropic',
    kind: 'anthropic',
    npm: '@ai-sdk/anthropic',
    baseUrl: 'https://b.example',
    apiKey: 'sk-b',
    resolvedModel: 'claude-b',
    billingMode: 'credits',
    markup: 1,
  };

  it('fails over a 429 to the second candidate and bills ONLY the one that served', async () => {
    const billed: UsageEvent[] = [];
    const gateway = createGateway(
      baseHooks({
        // Both candidates resolve for the requested model, in order [A, B].
        resolveUpstream: async () => [descA, descB],
        recordUsage: async (e) => {
          billed.push(e);
        },
      }),
      { aiSdkNative: true },
      {
        // Candidate A (a.example) returns a hard 429; candidate B serves.
        fetchImpl: async (url: string) => {
          if (url.includes('a.example')) {
            return new Response(
              JSON.stringify({
                type: 'error',
                error: { type: 'rate_limit_error', message: 'slow down' },
              }),
              { status: 429, headers: { 'content-type': 'application/json' } },
            );
          }
          return anthropicSse('served by B', 100, 50);
        },
      },
    );

    const res = await gateway.languageModel(req(HEADERS(), BODY));
    expect(res.status).toBe(200);
    const sse = await readStream(res);
    // B's content reached the client.
    expect(sse).toContain('served by B');

    // Exactly one billing event — for candidate B (claude-b), never A (claude-a).
    const billable = billed.filter((e) => e.promptTokens + e.completionTokens > 0);
    expect(billable).toHaveLength(1);
    expect(billable[0].model).toBe('claude-b');
    expect(billable[0].promptTokens).toBe(100);
    expect(billable[0].completionTokens).toBe(50);
  });

  it('surfaces a terminal 400 without failing over (no second dispatch, no billing)', async () => {
    const billed: UsageEvent[] = [];
    let bHit = false;
    const gateway = createGateway(
      baseHooks({
        resolveUpstream: async () => [descA, descB],
        recordUsage: async (e) => {
          billed.push(e);
        },
      }),
      { aiSdkNative: true },
      {
        fetchImpl: async (url: string) => {
          if (url.includes('a.example')) {
            return new Response(
              JSON.stringify({
                type: 'error',
                error: { type: 'invalid_request_error', message: 'bad request' },
              }),
              { status: 400, headers: { 'content-type': 'application/json' } },
            );
          }
          bHit = true;
          return anthropicSse('should not run', 1, 1);
        },
      },
    );

    const res = await gateway.languageModel(req(HEADERS(), BODY));
    // Terminal 4xx fails fast — the fallback candidate is never dispatched.
    expect(res.status).toBe(400);
    expect(bHit).toBe(false);
    expect(billed.filter((e) => e.promptTokens + e.completionTokens > 0)).toHaveLength(0);
  });

  it('preserves usage end-to-end on the committed happy path', async () => {
    const billed: UsageEvent[] = [];
    const gateway = createGateway(
      baseHooks({
        resolveUpstream: async () => [descB],
        recordUsage: async (e) => {
          billed.push(e);
        },
      }),
      { aiSdkNative: true },
      { fetchImpl: async () => anthropicSse('hello', 12, 7) },
    );
    const res = await gateway.languageModel(req(HEADERS(), BODY));
    expect(res.status).toBe(200);
    const sse = await readStream(res);
    // The AI-gateway finish frame carries the wire usage tree.
    expect(sse).toContain('"finish"');
    expect(sse).toContain('hello');
    const billable = billed.filter((e) => e.promptTokens + e.completionTokens > 0);
    expect(billable).toHaveLength(1);
    expect(billable[0].promptTokens).toBe(12);
    expect(billable[0].completionTokens).toBe(7);
  });
});
