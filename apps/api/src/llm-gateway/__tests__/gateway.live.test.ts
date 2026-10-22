import { describe, expect, test } from 'bun:test';
import { createGateway } from '@kortix/llm-gateway';
import type { GatewayHooks, UpstreamDescriptor, UsageEvent } from '@kortix/llm-gateway';

// Manual live proof. No CI lane runs this file: `scripts/test.sh` excludes
// `*.live.test.ts` from its default and integration sets, and the root suite
// does not call its `live` mode. Run it by hand with `bash scripts/test.sh live`
// (dotenvx supplies PLATINUM_INFERENCE_API_KEY and, optionally,
// PLATINUM_INFERENCE_URL). It spends real, small credits on Platinum inference
// through the same @kortix/llm-gateway pipeline that runs in-API and in the
// standalone pod. The client sees only Kortix.
const RUN_LIVE = !!process.env.PLATINUM_INFERENCE_API_KEY && process.env.RUN_LIVE_LLM_TESTS === '1';
const describeLive = RUN_LIVE ? describe : describe.skip;
// Imported only for a live run: the module validates API config at load. The
// lineup is whatever Platinum Inference lists right now.
const SERVED_MODELS = RUN_LIVE
  ? await (async () => {
      await (await import('../models/managed-models')).loadManagedLineup();
      return (await import('../models/served-managed-models')).servedManagedModels();
    })()
  : [];
const UPSTREAM_IDENTITY = /platinum|provider_name|z-ai\/|deepseek\//i;
// 32×32 solid red PNG.
const RED_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==';

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describeLive('Kortix-managed models — LIVE Platinum inference (RUN_LIVE_LLM_TESTS=1)', () => {
  async function managedGateway(mutate: (candidates: UpstreamDescriptor[]) => UpstreamDescriptor[] = (c) => c) {
    const { managedCandidates } = await import('../resolution/descriptors');
    const { getRuntimeManagedModel } = await import('../models/managed-models');
    const recorded: UsageEvent[] = [];
    const hooks: GatewayHooks = {
      authenticate: async () => ({ userId: 'live-user', accountId: 'live-acct' }),
      // resolve-candidates.ts adds this header in production.
      resolveUpstream: async (_principal, model) => mutate(managedCandidates(getRuntimeManagedModel(model)!)
        .map((c) => ({ ...c, headers: { 'x-platinum-session': 'kortix-live-test' } }))),
      assertBillingActive: async () => {},
      recordUsage: async (event) => { recorded.push(event); },
    };
    return { gateway: createGateway(hooks), recorded };
  }

  for (const model of SERVED_MODELS) {
    const content = model.vision
      ? [
          { type: 'text', text: 'What color is this image? One word.' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_PNG}` } },
        ]
      : 'Reply with the single word: red';
    test(`${model.id}: Platinum serves the turn and bills its usage.cost; the client sees only Kortix`, async () => {
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
      expect(recorded[0]).toMatchObject({ provider: 'kortix', model: model.id, upstream: { provider: 'platinum' } });
      expect(recorded[0].upstreamCost).toBeGreaterThan(0);
      expect(recorded[0].finalCost).toBeGreaterThan(recorded[0].upstreamCost);
    }, 120_000);

    test(`${model.id}: a streamed turn carries only Kortix identity and records usage`, async () => {
      const { gateway, recorded } = await managedGateway();
      const res = await gateway.chatCompletions({
        authorization: 'Bearer live',
        rawBody: JSON.stringify({ model: model.id, stream: true, max_tokens: 2000,
          messages: [{ role: 'user', content: 'Count to three.' }] }),
      });
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).toContain('data: [DONE]');
      expect(text).not.toMatch(UPSTREAM_IDENTITY);
      await settle();
      expect(recorded[0]).toMatchObject({ provider: 'kortix', model: model.id, upstream: { provider: 'platinum' } });
      expect(recorded[0].completionTokens).toBeGreaterThan(0);
      expect(recorded[0].upstreamCost).toBeGreaterThan(0);
    }, 120_000);
  }

  test('a rejected Platinum key reaches the client as a Kortix 503', async () => {
    const { gateway } = await managedGateway((candidates) => candidates.map((c) => ({ ...c, apiKey: 'pt_live_invalid' })));
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
