import { describe, expect, it } from 'bun:test';
import { createGateway } from '../create-gateway';
import type { AuthedPrincipal, GatewayHooks, UpstreamDescriptor } from '../domain';

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
      baseHooks({ assertBillingActive: async () => { billed = true; } }),
      { aiSdkNative: true },
    );
    const res = await gateway.languageModel(
      req(HEADERS({ 'ai-language-model-id': undefined }), BODY),
    );
    expect(res.status).toBe(400);
    expect(billed).toBe(false);
  });

  it('returns model_unavailable (400) when no upstream resolves', async () => {
    const gateway = createGateway(
      baseHooks({ resolveUpstream: async () => [] }),
      { aiSdkNative: true },
    );
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
        // Fetch double: the provider package calls this; return a minimal SSE so
        // streamText opens a stream without a real network call.
      }),
      { aiSdkNative: true },
      {
        fetchImpl: async () =>
          new Response('event: message\n\n', {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
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
