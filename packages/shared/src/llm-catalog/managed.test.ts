import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MANAGED_MODEL_IDS,
  MANAGED_FLAGSHIP_MODEL_ID,
  MANAGED_MODELS,
  getManagedModel,
  isManagedModelId,
} from './index';

describe('managed catalog', () => {
  test('exposes the expected passthrough lineup', () => {
    expect(DEFAULT_MANAGED_MODEL_IDS).toEqual([
      'claude-opus-4.8',
      'claude-sonnet-4.6',
      'deepseek-v3.2',
      'qwen3-max',
      'glm-4.6',
      'kimi-k2',
    ]);
  });

  test('the haiku/sonnet branded ids are gone from the served catalog', () => {
    expect(DEFAULT_MANAGED_MODEL_IDS).not.toContain('kortix-power');
    expect(DEFAULT_MANAGED_MODEL_IDS).not.toContain('kortix-basic');
  });

  test('Opus is the single flagship', () => {
    expect(MANAGED_FLAGSHIP_MODEL_ID).toBe('claude-opus-4.8');
    expect(MANAGED_MODELS.filter((m) => m.tier === 'flagship')).toHaveLength(1);
  });

  test('only Anthropic models carry a Bedrock id; Chinese models route via OpenRouter', () => {
    for (const m of MANAGED_MODELS) {
      expect(m.openRouterModelId.length).toBeGreaterThan(0);
      if (m.openRouterModelId.startsWith('anthropic/')) {
        expect(m.bedrockModelId, `${m.id} should be Bedrock-routable`).toBeDefined();
      } else {
        expect(m.bedrockModelId, `${m.id} (non-Anthropic) must not claim a Bedrock id`).toBeUndefined();
      }
    }
  });

  test('every Bedrock id is an Anthropic inference profile (our Bedrock transport is Anthropic-only)', () => {
    for (const m of MANAGED_MODELS) {
      if (m.bedrockModelId) expect(m.bedrockModelId).toContain('anthropic.claude');
    }
  });
});

describe('managed resolution + back-compat aliases', () => {
  test('resolves current ids', () => {
    expect(getManagedModel('claude-opus-4.8')?.name).toBe('Claude Opus 4.8');
    expect(getManagedModel('kimi-k2')?.openRouterModelId).toBe('moonshotai/kimi-k2');
  });

  test('retired branded ids still resolve (to the nearest current model) so stored configs do not break', () => {
    expect(getManagedModel('kortix-power')?.id).toBe('claude-sonnet-4.6');
    expect(getManagedModel('kortix-basic')?.id).toBe('claude-sonnet-4.6');
    expect(isManagedModelId('kortix-power')).toBe(true);
    expect(isManagedModelId('kortix-basic')).toBe(true);
  });

  test('a BYOK provider/model string is never treated as managed', () => {
    expect(isManagedModelId('anthropic/claude-opus-4.8')).toBe(false);
    expect(getManagedModel('anthropic/claude-opus-4.8')).toBeUndefined();
    expect(isManagedModelId('deepseek/deepseek-v3.2')).toBe(false);
  });

  test('unknown ids do not resolve', () => {
    expect(getManagedModel('nope')).toBeUndefined();
    expect(isManagedModelId('nope')).toBe(false);
  });
});
