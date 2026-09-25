import { describe, expect, test } from 'bun:test';
import { createGateway } from '@kortix/llm-gateway';
import type { GatewayHooks, UpstreamDescriptor, UsageEvent } from '@kortix/llm-gateway';

// Manual live proof. No CI lane runs this file: `scripts/test.sh` excludes
// `*.live.test.ts` from its default and integration sets, and the root suite
// does not call its `live` mode. Run it by hand with `bash scripts/test.sh live`
// (dotenvx supplies OPENROUTER_API_KEY and MORPH_API_KEY). It spends real,
// small credits against OpenRouter and Morph through the same
// @kortix/llm-gateway pipeline that runs in-API and in the standalone pod.
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
    expect(recorded[0].finalCost).toBeGreaterThan(0);
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

// Kortix-managed routing, for every model this deployment serves: Morph direct first, the ZDR OpenRouter
// pool on failure, and Kortix as the only identity a client sees. Needs
// MORPH_API_KEY and OPENROUTER_API_KEY (dotenvx) and KORTIX_MANAGED_PROVIDER_ENABLED.
const RUN_MANAGED_LIVE = RUN_LIVE && !!process.env.MORPH_API_KEY;
const describeManagedLive = RUN_MANAGED_LIVE ? describe : describe.skip;
// Imported only for a live run: the module validates API config at load.
const SERVED_MODELS = RUN_MANAGED_LIVE
  ? (await import('../models/served-managed-models')).SERVED_MANAGED_MODELS
  : [];
const UPSTREAM_IDENTITY =
  /openrouter|morph|coreweave|wafer|together|parasail|deepinfra|baseten|phala|fireworks|z-ai\/|moonshotai\/|deepseek\/|provider_name/i;
// 32×32 solid red PNG.
const RED_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==';

describeManagedLive('Kortix-managed routing — LIVE Morph + OpenRouter', () => {
  async function managedGateway(mutate: (candidates: UpstreamDescriptor[]) => UpstreamDescriptor[] = (c) => c) {
    const { managedCandidates } = await import('../resolution/descriptors');
    const { getManagedModel } = await import('@kortix/llm-catalog');
    const recorded: UsageEvent[] = [];
    const hooks: GatewayHooks = {
      authenticate: async () => ({ userId: 'live-user', accountId: 'live-acct' }),
      resolveUpstream: async (_principal, model) => mutate(managedCandidates(getManagedModel(model)!)),
      assertBillingActive: async () => {},
      recordUsage: async (event) => { recorded.push(event); },
    };
    return { gateway: createGateway(hooks), recorded };
  }

  for (const model of SERVED_MODELS) {
    const upstream = model.morphModelId ? 'morph' : 'openrouter';
    const content = model.vision
      ? [
          { type: 'text', text: 'What color is this image? One word.' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_PNG}` } },
        ]
      : 'Reply with the single word: red';
    test(`${model.id}: ${upstream} serves the turn; the client sees only Kortix`, async () => {
      const { gateway, recorded } = await managedGateway();
      const res = await gateway.chatCompletions({
        authorization: 'Bearer live',
        rawBody: JSON.stringify({ model: model.id, max_tokens: 2000, messages: [{ role: 'user', content }] }),
      });
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).not.toMatch(UPSTREAM_IDENTITY);
      const json = JSON.parse(text);
      expect(json.model).toBe(model.id);
      expect(json.choices[0].message.content.toLowerCase()).toContain('red');
      await settle();
      expect(recorded[0]).toMatchObject({ provider: 'kortix', model: model.id, upstream: { provider: upstream } });
      expect(recorded[0].finalCost).toBeGreaterThan(0);
    }, 120_000);
  }

  test('glm-5.3-flash: a streamed turn carries only Kortix identity', async () => {
    const { gateway, recorded } = await managedGateway();
    const res = await gateway.chatCompletions({
      authorization: 'Bearer live',
      rawBody: JSON.stringify({ model: 'glm-5.3-flash', stream: true, max_tokens: 2000,
        messages: [{ role: 'user', content: 'Count to three.' }] }),
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain('data: [DONE]');
    expect(text).not.toMatch(UPSTREAM_IDENTITY);
    await settle();
    expect(recorded[0]).toMatchObject({ provider: 'kortix', model: 'glm-5.3-flash', upstream: { provider: 'morph' } });
    expect(recorded[0].completionTokens).toBeGreaterThan(0);
  }, 120_000);

  test('glm-5.3-flash: a rejected Morph key fails over to the OpenRouter pool', async () => {
    const { gateway, recorded } = await managedGateway((candidates) =>
      candidates.map((c) => (c.provider === 'morph' ? { ...c, apiKey: 'sk-invalid' } : c)));
    const res = await gateway.chatCompletions({
      authorization: 'Bearer live',
      rawBody: JSON.stringify({ model: 'glm-5.3-flash', max_tokens: 2000,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }] }),
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toMatch(UPSTREAM_IDENTITY);
    await settle();
    expect(recorded[0]).toMatchObject({ provider: 'kortix', model: 'glm-5.3-flash', upstream: { provider: 'openrouter' } });
    expect(recorded[0].upstreamCost).toBeGreaterThan(0);
  }, 120_000);

  test('glm-5.3-flash: when every provider rejects the key, the client gets a Kortix 503', async () => {
    const { gateway } = await managedGateway((candidates) => candidates.map((c) => ({ ...c, apiKey: 'sk-invalid' })));
    const res = await gateway.chatCompletions({
      authorization: 'Bearer live',
      rawBody: JSON.stringify({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(text).not.toMatch(UPSTREAM_IDENTITY);
    expect(JSON.parse(text)).toMatchObject({ code: 'model_unavailable', provider: 'kortix', resolved_model: 'glm-5.3-flash' });
  }, 120_000);
});
