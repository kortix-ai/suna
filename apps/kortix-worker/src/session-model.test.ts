import { expect, test } from 'bun:test';
import { applySessionModelLimits, parseSessionModelSelection, readSessionModelSelection } from './session-model';

const selection = {
  model: { providerID: 'kortix', modelID: 'openai/model-a' },
  limits: { model: 'openai/model-a', context: 32768, output: 1024, images: true, reasoning: true, reasoningEfforts: ['none', 'high'] },
};

test('a model switch replaces context, output, images and reasoning capabilities without changing transport', () => {
  const original = { id: 'old', baseUrl: 'https://gateway.test/v1', provider: 'openrouter', input: ['text'] };
  const applied = applySessionModelLimits(original, selection);
  expect(applied).toMatchObject({ id: 'openai/model-a', baseUrl: original.baseUrl, provider: original.provider,
    contextWindow: 32768, maxTokens: 1024, input: ['text', 'image'], reasoning: true,
    thinkingLevelMap: { off: 'none', high: 'high', max: null } });
  expect(original.id).toBe('old');
});

test.each([null, {}, { ...selection, model: { providerID: 'openai', modelID: 'model-a' } },
  { ...selection, limits: { ...selection.limits, model: 'other' } },
  { ...selection, limits: { ...selection.limits, context: 0 } },
  { ...selection, limits: { ...selection.limits, images: 'true' } },
])('rejects inconsistent or malformed persisted model selections %j', value => {
  expect(() => parseSessionModelSelection(value)).toThrow();
});

test('configuration responses cannot redirect authentication or silently select an unvalidated model', async () => {
  let mode = 'redirect';
  const server = Bun.serve({ port: 0, fetch: () => mode === 'redirect'
    ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:1' } })
    : Response.json(mode === 'default' ? { opencode_model: null, limits: null } : { opencode_model: 'openai/model-a', limits: selection.limits }) });
  try {
    await expect(readSessionModelSelection(server.url.toString(), 'fixture')).rejects.toThrow();
    mode = 'invalid';
    await expect(readSessionModelSelection(server.url.toString(), 'fixture')).rejects.toThrow('Kortix gateway');
    mode = 'default';
    expect(await readSessionModelSelection(server.url.toString(), 'fixture')).toBeNull();
  } finally { server.stop(true); }
});
