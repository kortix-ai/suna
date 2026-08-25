import { describe, expect, test } from 'bun:test';

import {
  type EnablementCandidate,
  bedrockInferenceProfileRank,
  defaultEnabledModelIds,
} from './enablement';

const NOW = new Date('2026-07-29T00:00:00Z');

function ids(models: EnablementCandidate[]): string[] {
  return [...defaultEnabledModelIds(models, { now: NOW })].sort();
}

describe('defaultEnabledModelIds', () => {
  test('keeps only the newest model of each family', () => {
    expect(
      ids([
        { id: 'anthropic/claude-sonnet-5', family: 'claude-5', released: '2026-06-01' },
        { id: 'anthropic/claude-sonnet-4-6', family: 'claude-5', released: '2026-05-01' },
        { id: 'anthropic/claude-opus-5', family: 'opus-5', released: '2026-06-10' },
      ]),
    ).toEqual(['anthropic/claude-opus-5', 'anthropic/claude-sonnet-5']);
  });

  test('drops families whose newest release is outside the window', () => {
    expect(
      ids([
        { id: 'anthropic/claude-sonnet-5', family: 'claude-5', released: '2026-06-01' },
        { id: 'anthropic/claude-opus-4-1', family: 'claude-4', released: '2025-08-01' },
      ]),
    ).toEqual(['anthropic/claude-sonnet-5']);
  });

  test('groups by real upstream provider, not the synthetic kortix id', () => {
    // Both are served under `kortix`; a shared family name must not let one
    // provider's model suppress the other's.
    expect(
      ids([
        { id: 'anthropic/a-1', provider: 'anthropic', family: 'shared', released: '2026-06-01' },
        { id: 'openai/o-1', provider: 'openai', family: 'shared', released: '2026-05-01' },
      ]),
    ).toEqual(['anthropic/a-1', 'openai/o-1']);
  });

  test('treats a bare wire id as managed', () => {
    expect(ids([{ id: 'glm-5.2', family: 'glm', released: '2026-06-01' }])).toEqual(['glm-5.2']);
  });

  test('keeps a provider whose models are all stale or undated', () => {
    // Otherwise a connected provider silently contributes nothing at all.
    expect(
      ids([
        { id: 'mistral/old', family: 'm', released: '2020-01-01' },
        { id: 'mistral/older', family: 'm', released: '2019-01-01' },
      ]),
    ).toEqual(['mistral/old']);
    expect(ids([{ id: 'mistral/undated' }])).toEqual(['mistral/undated']);
  });

  test('falls back to the model id when no family is published', () => {
    expect(
      ids([
        { id: 'openai/gpt-a', released: '2026-06-01' },
        { id: 'openai/gpt-b', released: '2026-06-02' },
      ]),
    ).toEqual(['openai/gpt-a', 'openai/gpt-b']);
  });

  test('is empty for an empty catalog', () => {
    expect(ids([])).toEqual([]);
  });
});

describe('Bedrock inference profiles win a family tie', () => {
  // models.dev lists the bare in-region id AND its cross-region inference
  // profile(s) with the same family and release date. Bedrock refuses the bare
  // id for these models ("Invocation of model ID openai.gpt-5.6-luna with
  // on-demand throughput isn't supported") — so a tie must never surface it.
  test('global. beats the bare in-region id; us./eu. beat bare too', () => {
    expect(
      ids([
        { id: 'amazon-bedrock/openai.gpt-5.6-luna', family: 'gpt-luna', released: '2026-07-09', provider: 'amazon-bedrock' },
        { id: 'amazon-bedrock/global.openai.gpt-5.6-luna', family: 'gpt-luna', released: '2026-07-09', provider: 'amazon-bedrock' },
        { id: 'amazon-bedrock/anthropic.claude-fable-5', family: 'claude-fable', released: '2026-06-09', provider: 'amazon-bedrock' },
        { id: 'amazon-bedrock/us.anthropic.claude-fable-5', family: 'claude-fable', released: '2026-06-09', provider: 'amazon-bedrock' },
      ]),
    ).toEqual(['amazon-bedrock/global.openai.gpt-5.6-luna', 'amazon-bedrock/us.anthropic.claude-fable-5']);
  });

  test('global. beats a regional profile on a tie', () => {
    expect(
      ids([
        { id: 'amazon-bedrock/us.anthropic.claude-fable-5', family: 'claude-fable', released: '2026-06-09', provider: 'amazon-bedrock' },
        { id: 'amazon-bedrock/global.anthropic.claude-fable-5', family: 'claude-fable', released: '2026-06-09', provider: 'amazon-bedrock' },
      ]),
    ).toEqual(['amazon-bedrock/global.anthropic.claude-fable-5']);
  });

  test('a newer release still wins over an older profile — the rank only breaks ties', () => {
    expect(
      ids([
        { id: 'amazon-bedrock/global.openai.gpt-5.5', family: 'gpt', released: '2026-04-23', provider: 'amazon-bedrock' },
        { id: 'amazon-bedrock/openai.gpt-5.6-sol', family: 'gpt', released: '2026-07-09', provider: 'amazon-bedrock' },
      ]),
    ).toEqual(['amazon-bedrock/openai.gpt-5.6-sol']);
  });

  test('bedrockInferenceProfileRank: global > regional > bare, provider prefix tolerated', () => {
    expect(bedrockInferenceProfileRank('global.openai.gpt-5.6-sol')).toBe(2);
    expect(bedrockInferenceProfileRank('amazon-bedrock/global.openai.gpt-5.6-sol')).toBe(2);
    expect(bedrockInferenceProfileRank('us.anthropic.claude-fable-5')).toBe(1);
    expect(bedrockInferenceProfileRank('apac.anthropic.claude-sonnet-5')).toBe(1);
    expect(bedrockInferenceProfileRank('openai.gpt-5.6-sol')).toBe(0);
    expect(bedrockInferenceProfileRank('zai.glm-5')).toBe(0);
  });
});
