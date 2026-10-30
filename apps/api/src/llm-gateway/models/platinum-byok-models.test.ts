import { beforeEach, expect, test } from 'bun:test';
import { platinumModelsForKey, __clearPlatinumByokCacheForTest } from './platinum-byok-models';

const list = {
  object: 'list',
  data: [
    { id: 'box-model', object: 'model', owned_by: 'tabby' },
    {
      id: 'deepseek-v4.1-flash', object: 'model', owned_by: 'platinum', name: 'DeepSeek V4.1 Flash',
      context_length: 1_000_000, max_output_tokens: 65_536,
      pricing: { input: 0.15, cached_input: 0.003, output: 0.6 },
      modalities: { input: ['text', 'image'], output: ['text'] }, reasoning_efforts: ['none', 'low', 'high', 'max'],
    },
  ],
};
let calls: Array<{ url: string; auth: string | null }> = [];
let answer: () => Response = () => Response.json(list);
const fakeFetch = async (url: string, init?: RequestInit) => {
  calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
  return answer();
};

beforeEach(() => { calls = []; answer = () => Response.json(list); __clearPlatinumByokCacheForTest(); });

test("maps Platinum's named models for the key and skips the GPU box's raw models", async () => {
  const models = await platinumModelsForKey('pt_live_a', fakeFetch, 0);
  expect(calls).toEqual([{ url: 'https://api.platinum.dev/v1/inference/models', auth: 'Bearer pt_live_a' }]);
  expect(models).toEqual([{
    id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash',
    pricing: { inputPerMillion: 0.15, outputPerMillion: 0.6, cachedInputPerMillion: 0.003 },
    vision: true, reasoningOptions: [{ type: 'effort', values: ['none', 'low', 'high', 'max'] }],
    limit: { context: 1_000_000, output: 65_536 },
  }]);
});

test('caches per key for 5 min, then refetches; another key reads its own list', async () => {
  await platinumModelsForKey('pt_live_a', fakeFetch, 0);
  await platinumModelsForKey('pt_live_a', fakeFetch, 299_999);
  expect(calls).toHaveLength(1);
  await platinumModelsForKey('pt_live_b', fakeFetch, 1);
  await platinumModelsForKey('pt_live_a', fakeFetch, 300_000);
  expect(calls.map((c) => c.auth)).toEqual(['Bearer pt_live_a', 'Bearer pt_live_b', 'Bearer pt_live_a']);
});

test('an outage keeps the last good list; a rejected key has no models', async () => {
  await platinumModelsForKey('pt_live_a', fakeFetch, 0);
  answer = () => new Response('down', { status: 503 });
  expect(await platinumModelsForKey('pt_live_a', fakeFetch, 400_000)).toHaveLength(1);
  answer = () => new Response('no', { status: 401 });
  expect(await platinumModelsForKey('pt_live_a', fakeFetch, 800_000)).toEqual([]);
  expect(await platinumModelsForKey('pt_live_new', fakeFetch, 800_001)).toEqual([]);
});
