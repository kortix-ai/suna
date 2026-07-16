import { beforeEach, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import { getProjectModelPicker } from './projects';

let calls: Array<{ url: string; method: string }> = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(
    async (url: unknown, opts: { method?: string } = {}) => {
      calls.push({ url: String(url), method: opts.method ?? 'GET' });
      return new Response(JSON.stringify({ models: { auto: { name: 'Auto' } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  ) as unknown as typeof fetch;
});

configureKortix({
  backendUrl: 'http://test.local',
  getToken: async () => 'tok',
});

test('loads the compact project model picker instead of the full runtime catalog', async () => {
  const result = await getProjectModelPicker('P1');
  expect(result.models.auto?.name).toBe('Auto');
  expect(calls.at(-1)).toEqual({
    url: 'http://test.local/projects/P1/model-picker',
    method: 'GET',
  });
});
