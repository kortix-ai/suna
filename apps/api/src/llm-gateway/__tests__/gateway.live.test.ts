import { describe, test, expect } from 'bun:test';
import { createLlmGateway } from '..';
import type { LlmGatewayConfig, LlmGatewayHooks, UsageEvent } from '../types';

const LIVE_KEY = process.env.KORTIX_OPENROUTER_API_KEY ?? '';
const RUN_LIVE = !!LIVE_KEY && process.env.RUN_LIVE_LLM_TESTS === '1';
const CHEAP_MODEL = process.env.LIVE_TEST_MODEL ?? 'google/gemini-2.0-flash-lite-001';

const describeLive = RUN_LIVE ? describe : describe.skip;

function makeApp(overrides: Partial<LlmGatewayConfig> = {}) {
  const recorded: UsageEvent[] = [];
  const hooks: LlmGatewayHooks = {
    authenticateToken: async () => ({ userId: 'live-test-user', accountId: 'live-test-account' }),
    assertBillingActive: async () => {},
    recordUsage: async (event) => { recorded.push(event); },
  };
  const config: LlmGatewayConfig = {
    enabled: true,
    openrouterApiKey: LIVE_KEY,
    baseUrl: 'https://openrouter.ai/api/v1',
    markup: 1.2,
    appName: 'Kortix-LiveTests',
    ...overrides,
  };
  return { app: createLlmGateway(config, hooks), recorded };
}

describeLive('llm-gateway — LIVE OpenRouter (RUN_LIVE_LLM_TESTS=1)', () => {
  test('GET /models returns a non-empty catalog', async () => {
    const { app } = makeApp();
    const res = await app.fetch(new Request('http://local.test/models'));
    expect(res.status).toBe(200);
    const body = await res.json() as { data?: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data ?? []).length).toBeGreaterThan(10);
  }, 20_000);

  test('POST /chat/completions (non-streaming) returns a real response + records usage', async () => {
    const { app, recorded } = makeApp();
    const res = await app.fetch(
      new Request('http://local.test/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer any-token-since-auth-stub-accepts-anything',
        },
        body: JSON.stringify({
          model: CHEAP_MODEL,
          messages: [{ role: 'user', content: 'Say hi in one word.' }],
          max_tokens: 10,
        }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.choices?.[0]?.message?.content).toBeDefined();
    expect(typeof body.choices[0].message.content).toBe('string');
    expect(body.usage?.prompt_tokens).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 50));
    expect(recorded.length).toBe(1);
    const event = recorded[0];
    expect(event.accountId).toBe('live-test-account');
    expect(event.actorUserId).toBe('live-test-user');
    expect(event.provider).toBe('openrouter');
    expect(event.model).toBe(CHEAP_MODEL);
    expect(event.promptTokens).toBeGreaterThan(0);
    expect(event.completionTokens).toBeGreaterThan(0);
    expect(event.upstreamCost).toBeGreaterThan(0);
    expect(event.finalCost).toBeCloseTo(event.upstreamCost * 1.2, 6);
    expect(event.streaming).toBe(false);
  }, 30_000);

  test('POST /chat/completions (streaming) streams chunks + records usage at end', async () => {
    const { app, recorded } = makeApp();
    const res = await app.fetch(
      new Request('http://local.test/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer any-token-since-auth-stub-accepts-anything',
        },
        body: JSON.stringify({
          model: CHEAP_MODEL,
          messages: [{ role: 'user', content: 'Count to three.' }],
          max_tokens: 30,
          stream: true,
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let fullBuffer = '';
    let chunkCount = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        fullBuffer += decoder.decode(value, { stream: true });
        chunkCount += 1;
      }
    }

    expect(chunkCount).toBeGreaterThan(1);
    expect(fullBuffer).toContain('data:');
    expect(fullBuffer).toContain('[DONE]');

    await new Promise((r) => setTimeout(r, 200));
    expect(recorded.length).toBe(1);
    const event = recorded[0];
    expect(event.streaming).toBe(true);
    expect(event.promptTokens).toBeGreaterThan(0);
    expect(event.completionTokens).toBeGreaterThan(0);
  }, 45_000);

  test('Invalid model returns a 4xx from upstream (proxied through)', async () => {
    const { app } = makeApp();
    const res = await app.fetch(
      new Request('http://local.test/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer any',
        },
        body: JSON.stringify({
          model: 'this-model/does-not-exist',
          messages: [{ role: 'user', content: 'Hi.' }],
        }),
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  }, 20_000);
});

if (!RUN_LIVE) {
  describe('llm-gateway — LIVE OpenRouter (skipped)', () => {
    test('set KORTIX_OPENROUTER_API_KEY + RUN_LIVE_LLM_TESTS=1 to run', () => {
      expect(true).toBe(true);
    });
  });
}
