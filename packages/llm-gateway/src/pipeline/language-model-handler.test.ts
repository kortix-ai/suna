import { describe, expect, it } from 'bun:test';
import { createGateway } from '../create-gateway';
import type { AuthedPrincipal, GatewayHooks, UpstreamDescriptor, UsageEvent } from '../domain';

// A complete Anthropic streaming SSE body: one text delta + input/output usage.
// Shaped exactly as @ai-sdk/anthropic's doStream parses it, so real `streamText`
// (driven by the native handler) yields a `text-delta` + a `finish` with usage.
function anthropicSse(text: string, inputTokens: number, outputTokens: number): Response {
  const body = `event: message_start\ndata: ${JSON.stringify({
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
  })}\n\nevent: content_block_start\ndata: ${JSON.stringify({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  })}\n\nevent: content_block_delta\ndata: ${JSON.stringify({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  })}\n\nevent: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\nevent: message_delta\ndata: ${JSON.stringify(
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: outputTokens },
    },
  )}\n\nevent: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

// A PARTIAL Anthropic stream: message_start + a content delta, then the body is
// held OPEN (never a message_delta/message_stop). streamText yields the
// `text-delta` (so the failover probe commits + content reaches the client) but
// never a `finish` — the exact shape of a turn a client disconnects mid-stream.
function anthropicSsePartial(text: string, inputTokens: number): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        enc.encode(
          `event: message_start\ndata: ${JSON.stringify({
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
          })}\n\nevent: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          })}\n\nevent: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text },
          })}\n\n`,
        ),
      );
      // Intentionally NOT closed — the turn never reaches `finish`.
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
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

// A held turn attaches an admission `billingHold` (via assertBillingActive
// returning `holdUsd`). The host reconciles that hold PER usage event: a refund
// event undoes it, a real event carrying `billingHoldUsd` reconciles it against
// the actual cost. Reconciling the SAME hold across TWO events undercharges by
// the hold amount — the exact double-reconcile bug these tests pin.
describe('handleLanguageModel — admission billing-hold reconciliation (FIX 1)', () => {
  const HOLD_USD = 0.5;
  const descHold: UpstreamDescriptor = {
    provider: 'anthropic',
    kind: 'anthropic',
    npm: '@ai-sdk/anthropic',
    baseUrl: 'https://hold.example',
    apiKey: 'sk-h',
    resolvedModel: 'claude-hold',
    billingMode: 'credits',
    markup: 1,
  };

  function heldHooks(billed: UsageEvent[], over: Partial<GatewayHooks> = {}): GatewayHooks {
    return baseHooks({
      // Attach a hold of HOLD_USD to the admitted principal.
      assertBillingActive: async () => ({ holdUsd: HOLD_USD }),
      resolveUpstream: async () => [descHold],
      recordUsage: async (e) => {
        billed.push(e);
      },
      ...over,
    });
  }

  it('a held turn that COMPLETES reconciles the hold EXACTLY ONCE (no double-refund, no undercharge)', async () => {
    const billed: UsageEvent[] = [];
    const gateway = createGateway(
      heldHooks(billed),
      { aiSdkNative: true },
      {
        fetchImpl: async () => anthropicSse('done', 80, 40),
      },
    );

    const res = await gateway.languageModel(req(HEADERS(), BODY));
    expect(res.status).toBe(200);
    await readStream(res);
    // Let any stray fire-and-forget refund microtask settle (there must be none).
    await new Promise((r) => setTimeout(r, 20));

    // EXACTLY ONE recordUsage event — the real settle. The deleted microtask
    // refund would have produced a SECOND, zero-usage, hold-refund event here.
    expect(billed).toHaveLength(1);
    const event = billed[0];
    // The single event carries the REAL usage AND reconciles the hold once.
    expect(event.promptTokens).toBe(80);
    expect(event.completionTokens).toBe(40);
    expect(event.billingHoldUsd).toBe(HOLD_USD);
    // No zero-usage refund event exists (that is the double-reconcile signature).
    expect(billed.filter((e) => e.promptTokens === 0 && e.completionTokens === 0)).toHaveLength(0);
  });

  it('a held turn CANCELLED before finish refunds the hold ONCE and never bills', async () => {
    const billed: UsageEvent[] = [];
    const gateway = createGateway(
      heldHooks(billed),
      { aiSdkNative: true },
      {
        // Content streams, but the upstream never sends `finish` — the client
        // disconnects mid-stream (cancel below).
        fetchImpl: async () => anthropicSsePartial('partial answer', 80),
      },
    );

    const res = await gateway.languageModel(req(HEADERS(), BODY));
    expect(res.status).toBe(200);

    // Read until the committed content reaches the client, then CANCEL (client
    // disconnect) before the turn ever finishes.
    const reader = res.body?.getReader();
    if (!reader) throw new Error('no body');
    const dec = new TextDecoder();
    let acc = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) acc += dec.decode(value, { stream: true });
      if (acc.includes('partial answer')) {
        // Do NOT await: the refund fires synchronously inside the serializer's
        // cancel() BEFORE it awaits the upstream teardown (which never resolves
        // here — the fake upstream never closes).
        void reader.cancel().catch(() => {});
        break;
      }
    }
    // Let the fire-and-forget refund recordUsage settle.
    await new Promise((r) => setTimeout(r, 30));

    // EXACTLY ONE recordUsage event — the hold refund. No billable event.
    expect(billed).toHaveLength(1);
    const refund = billed[0];
    expect(refund.promptTokens).toBe(0);
    expect(refund.completionTokens).toBe(0);
    expect(refund.finalCost).toBe(0);
    expect(refund.billingHoldUsd).toBe(HOLD_USD);
    expect(billed.filter((e) => e.promptTokens + e.completionTokens > 0)).toHaveLength(0);
  });
});

// Prove the GATEWAY-SIDE request shaping reaches the UPSTREAM WIRE through the
// real @ai-sdk provider serialization (not just the pure helper). A capturing
// fetch double records the outgoing request body; the stream then errors out
// (the body is already captured), so each test asserts on the wire body
// regardless of the final response status.
function captureBodyGateway(descriptor: UpstreamDescriptor) {
  const captured: { url: string; body: Record<string, unknown> | null } = { url: '', body: null };
  const gateway = createGateway(
    baseHooks({ resolveUpstream: async () => [descriptor] }),
    { aiSdkNative: true },
    {
      fetchImpl: async (url: string, init?: { body?: unknown }) => {
        captured.url = url;
        try {
          captured.body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        } catch {
          captured.body = null;
        }
        // End the attempt immediately — the body is already captured. A terminal
        // 400 stops failover; the handler returns an error, which these tests
        // ignore in favor of the captured wire body.
        return new Response(JSON.stringify({ error: { message: 'captured' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  );
  return { gateway, captured };
}

describe('handleLanguageModel — gateway-side wire shaping (codex store:false)', () => {
  const CODEX: UpstreamDescriptor = {
    provider: 'openai-codex',
    kind: 'openai-responses',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    apiKey: 'sk-codex',
    resolvedModel: 'gpt-5.6-sol',
    billingMode: 'credits',
    markup: 1,
  };

  it('sends store:false and NO max_output_tokens for a codex model', async () => {
    const { gateway, captured } = captureBodyGateway(CODEX);
    await gateway.languageModel(
      req(HEADERS({ 'ai-language-model-id': 'openai/gpt-5.6-sol' }), {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        maxOutputTokens: 4096,
      }),
    );
    expect(captured.body).not.toBeNull();
    // The confirmed prod bug: without the fix, `store` is dropped and codex 400s
    // "Store must be set to false".
    expect(captured.body?.store).toBe(false);
    // Codex 400s on max_output_tokens — it must be absent.
    expect('max_output_tokens' in (captured.body ?? {})).toBe(false);
  });
});

describe('handleLanguageModel — gateway-side wire shaping (plain openai)', () => {
  const OPENAI: UpstreamDescriptor = {
    provider: 'openai',
    kind: 'openai-compat',
    npm: '@ai-sdk/openai',
    baseUrl: 'https://api.openai.com',
    apiKey: 'sk-openai',
    resolvedModel: 'gpt-4o',
    billingMode: 'credits',
    markup: 1,
  };

  it('does NOT set store for a non-codex openai model', async () => {
    const { gateway, captured } = captureBodyGateway(OPENAI);
    await gateway.languageModel(
      req(HEADERS({ 'ai-language-model-id': 'openai/gpt-4o' }), {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        maxOutputTokens: 512,
      }),
    );
    expect(captured.body).not.toBeNull();
    // store:false is codex-only; a plain openai chat request must never carry it.
    expect(captured.body?.store).toBeUndefined();
  });
});

describe('handleLanguageModel — gateway-side wire shaping (openrouter bodyExtras)', () => {
  const OPENROUTER: UpstreamDescriptor = {
    provider: 'openrouter',
    kind: 'openai-compat',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'sk-or',
    resolvedModel: 'anthropic/claude-x',
    billingMode: 'credits',
    markup: 1,
    bodyExtras: { provider: { order: ['Anthropic'], allow_fallbacks: false } },
  };

  it('forwards descriptor.bodyExtras (provider routing pins) onto the wire', async () => {
    const { gateway, captured } = captureBodyGateway(OPENROUTER);
    await gateway.languageModel(
      req(HEADERS({ 'ai-language-model-id': 'openrouter/anthropic/claude-x' }), {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }),
    );
    expect(captured.body).not.toBeNull();
    // The OpenRouter `provider` routing pin the client cannot send must reach the
    // upstream verbatim (openai-compatible spreads unknown providerOptions keys).
    expect(captured.body?.provider).toEqual({ order: ['Anthropic'], allow_fallbacks: false });
  });
});

describe('handleLanguageModel — gateway-side wire shaping (anthropic regression)', () => {
  const ANTHROPIC: UpstreamDescriptor = {
    provider: 'anthropic',
    kind: 'anthropic',
    npm: '@ai-sdk/anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-anthropic',
    resolvedModel: 'claude-fable-5',
    billingMode: 'credits',
    markup: 1,
  };

  it('forwards client providerOptions (thinking) + maxOutputTokens, adds no store', async () => {
    const { gateway, captured } = captureBodyGateway(ANTHROPIC);
    await gateway.languageModel(
      req(HEADERS(), {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        maxOutputTokens: 1024,
        providerOptions: { anthropic: { thinking: { type: 'adaptive' }, effort: 'high' } },
      }),
    );
    expect(captured.body).not.toBeNull();
    // The Anthropic wire carries max_tokens (client cap forwarded unchanged) and
    // the adaptive-thinking block from the client's own providerOptions.
    expect(captured.body?.max_tokens).toBe(1024);
    expect(captured.body?.thinking).toEqual({ type: 'adaptive' });
    // No codex/openai shaping leaked into a non-openai family.
    expect(captured.body?.store).toBeUndefined();
  });
});

describe('handleLanguageModel — request-size ceiling (FIX 2)', () => {
  it('returns 413 request_too_large when the body exceeds maxRequestBytes, before auth/billing', async () => {
    let authenticated = false;
    const gateway = createGateway(
      baseHooks({
        authenticate: async (token) => {
          authenticated = true;
          return token === 'good' ? PRINCIPAL : null;
        },
      }),
      { aiSdkNative: true, maxRequestBytes: 16 },
    );
    const bigBody = {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(500) }] }],
    };
    const res = await gateway.languageModel(req(HEADERS(), bigBody));
    expect(res.status).toBe(413);
    const data = (await res.json()) as { code?: string };
    expect(data.code).toBe('request_too_large');
    // The guard runs BEFORE the auth gate — the wallet is never touched.
    expect(authenticated).toBe(false);
  });

  it('does NOT reject a normal body when maxRequestBytes is generous', async () => {
    const gateway = createGateway(baseHooks({ resolveUpstream: async () => [] }), {
      aiSdkNative: true,
      maxRequestBytes: 1_000_000,
    });
    const res = await gateway.languageModel(req(HEADERS(), BODY));
    // Passes the size gate; fails later at route resolution (no upstream).
    expect(res.status).not.toBe(413);
    expect(res.status).toBe(400);
  });
});
