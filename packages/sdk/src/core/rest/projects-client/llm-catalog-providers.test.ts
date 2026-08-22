import { beforeEach, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import { getProjectLlmCatalogProviders } from './projects';

let calls: Array<{ url: string; method: string }> = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string } = {}) => {
    calls.push({ url: String(url), method: opts.method ?? 'GET' });
    return new Response(
      JSON.stringify({
        source: 'https://models.dev/api.json',
        fetched_at: '2026-07-17T00:00:00.000Z',
        provider_count: 1,
        model_count: 1,
        providers: [
          {
            id: 'amazon-bedrock',
            name: 'Amazon Bedrock',
            env: [
              'AWS_ACCESS_KEY_ID',
              'AWS_SECRET_ACCESS_KEY',
              'AWS_REGION',
              'AWS_BEARER_TOKEN_BEDROCK',
            ],
            doc: 'https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html',
            api: null,
            npm: '@ai-sdk/amazon-bedrock',
            models: [{ id: 'anthropic.claude-opus-4', name: 'Claude Opus 4' }],
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
});

configureKortix({
  backendUrl: 'http://test.local',
  getToken: async () => 'tok',
});

test('loads the live provider-level catalog (not gated by llm_gateway, unlike model-picker)', async () => {
  const result = await getProjectLlmCatalogProviders('P1');
  expect(result.providers[0]?.id).toBe('amazon-bedrock');
  expect(result.providers[0]?.env).toContain('AWS_BEARER_TOKEN_BEDROCK');
  expect(calls.at(-1)).toEqual({
    url: 'http://test.local/projects/P1/llm-catalog/providers',
    method: 'GET',
  });
});
