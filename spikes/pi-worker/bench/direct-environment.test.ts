import { expect, test } from 'bun:test';
import {
  BENCHMARK_SYSTEM,
  opencodeConfig,
  sampleOrder,
  summarizeSamples,
} from './direct-environment.ts';

test('alternate the first runtime without concurrent model calls', () => {
  expect(sampleOrder(0)).toEqual(['pi', 'opencode']);
  expect(sampleOrder(1)).toEqual(['opencode', 'pi']);
  expect(sampleOrder(2)).toEqual(['pi', 'opencode']);
});

test('report failures and keep scenario distributions separate', () => {
  const result = summarizeSamples([
    {
      runtime: 'pi',
      case: 'short',
      ok: true,
      firstTokenMs: 100,
      completionMs: 200,
    },
    {
      runtime: 'pi',
      case: 'short',
      ok: false,
      firstTokenMs: 1,
      completionMs: 2,
    },
    {
      runtime: 'pi',
      case: 'short',
      ok: true,
      firstTokenMs: 200,
      completionMs: 400,
    },
    { runtime: 'pi', case: 'tool', ok: false },
  ]);
  expect(result[0]).toMatchObject({
    attempted: 3,
    passed: 2,
    firstTokenMs: { n: 2, median: 150, min: 100, max: 200 },
    completionMs: { median: 300 },
  });
  expect(result[1]).toMatchObject({
    attempted: 1,
    passed: 0,
    firstTokenMs: null,
  });
});

test('OpenCode uses the shared model and prompt without persisting a credential', () => {
  const config = opencodeConfig('https://gateway.example/v1/llm', 'gpt-5.6-luna');
  expect(config.model).toBe('kortix/gpt-5.6-luna');
  expect(config.agent.bench.prompt).toBe(BENCHMARK_SYSTEM);
  expect(config.provider.kortix.options.apiKey).toBe('{env:KORTIX_TOKEN}');
  expect(
    Object.entries(config.agent.bench.tools)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name)
      .sort(),
  ).toEqual(['bash', 'edit', 'glob', 'grep', 'read', 'write']);
});
