import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MANAGED_MODEL_IDS,
  MANAGED_FLAGSHIP_MODEL_ID,
  MANAGED_MODELS,
  getManagedModel,
  isManagedModelId,
} from './index';

describe('managed catalog', () => {
  test('exposes the managed lineup', () => {
    expect(DEFAULT_MANAGED_MODEL_IDS).toEqual([
      'claude-opus-4.8',
      'claude-sonnet-4.6',
      'kimi-k2',
      'kimi-k2-thinking',
      'minimax-m2.5',
      'glm-4.6',
      'glm-4.7',
      'qwen3-max',
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

  test('every model has an upstream id, transport, and pricing ref', () => {
    for (const m of MANAGED_MODELS) {
      expect(m.upstreamModelId.length, `${m.id} needs an upstream id`).toBeGreaterThan(0);
      expect(m.pricingRef.length, `${m.id} needs a pricing ref`).toBeGreaterThan(0);
      expect(['bedrock', 'bedrock-converse', 'openrouter']).toContain(m.transport);
    }
  });

  test('transport matches the upstream id shape', () => {
    for (const m of MANAGED_MODELS) {
      if (m.upstreamModelId.includes('anthropic.claude')) {
        expect(m.transport, `${m.id} (Anthropic) → invoke`).toBe('bedrock');
      } else if (m.transport === 'openrouter') {
        // OpenRouter slugs are provider/model.
        expect(m.upstreamModelId, `${m.id} OpenRouter slug`).toContain('/');
      } else {
        expect(m.transport, `${m.id} (non-Anthropic Bedrock) → Converse`).toBe('bedrock-converse');
      }
    }
  });
});

describe('managed resolution + back-compat aliases', () => {
  test('resolves current ids', () => {
    expect(getManagedModel('claude-opus-4.8')?.name).toBe('Claude Opus 4.8');
    expect(getManagedModel('kimi-k2')?.upstreamModelId).toBe('moonshotai.kimi-k2.5');
    expect(getManagedModel('kimi-k2')?.transport).toBe('bedrock-converse');
    expect(getManagedModel('glm-4.6')?.transport).toBe('openrouter');
    expect(getManagedModel('glm-4.6')?.upstreamModelId).toBe('z-ai/glm-4.6');
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
