import { describe, expect, test } from 'bun:test';
import { createGateway } from '@kortix/llm-gateway';
import type { GatewayHooks, UpstreamDescriptor, UsageEvent } from '@kortix/llm-gateway';

// Live e2e against real OpenRouter through the UNIFIED pipeline (the same
// @kortix/llm-gateway code that runs in-API and in the standalone pod). Skipped
// unless RUN_LIVE_LLM_TESTS=1 and OPENROUTER_API_KEY are set — it spends real
// (tiny) credits. Run: `bash scripts/test.sh live`.
const LIVE_KEY = process.env.OPENROUTER_API_KEY ?? '';
const RUN_LIVE = !!LIVE_KEY && process.env.RUN_LIVE_LLM_TESTS === '1';
const CHEAP_MODEL = process.env.LIVE_TEST_MODEL ?? 'deepseek/deepseek-v4-flash';

const describeLive = RUN_LIVE ? describe : describe.skip;

function makeGateway() {
  const recorded: UsageEvent[] = [];
  const descriptor: UpstreamDescriptor = {
    provider: 'openrouter',
    kind: 'openai-compat',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: LIVE_KEY,
    billingMode: 'credits',
    markup: 1.2,
    resolvedModel: CHEAP_MODEL,
    appName: 'Kortix-LiveTests',
  };
  const hooks: GatewayHooks = {
    authenticate: async () => ({ userId: 'live-user', accountId: 'live-acct' }),
    resolveUpstream: async () => [descriptor],
    assertBillingActive: async () => {},
    recordUsage: async (event) => {
      recorded.push(event);
    },
  };
  return { gateway: createGateway(hooks), recorded };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describeLive('llm-gateway unified pipeline — LIVE OpenRouter (RUN_LIVE_LLM_TESTS=1)', () => {
  test('non-streaming completion returns content and records usage', async () => {
    const { gateway, recorded } = makeGateway();
    const res = await gateway.chatCompletions({
      authorization: 'Bearer live',
      rawBody: JSON.stringify({
        model: CHEAP_MODEL,
        messages: [{ role: 'user', content: 'Reply with exactly one word: hello' }],
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    expect(json.choices?.[0]?.message?.content).toBeTruthy();
    await settle();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].completionTokens).toBeGreaterThan(0);
    expect(recorded[0].finalCost).toBeGreaterThanOrEqual(0);
  });

  test('streaming completion relays SSE and records usage from the final chunk', async () => {
    const { gateway, recorded } = makeGateway();
    const res = await gateway.chatCompletions({
      authorization: 'Bearer live',
      rawBody: JSON.stringify({
        model: CHEAP_MODEL,
        stream: true,
        messages: [{ role: 'user', content: 'Count to three.' }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('data:');
    await settle();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].completionTokens).toBeGreaterThan(0);
  });
});
