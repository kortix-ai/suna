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
      'glm-5.2',
      'qwen3.7-max',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
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
      expect(['bedrock', 'openrouter']).toContain(m.transport);
    }
  });

  test('transport matches the upstream id shape', () => {
    for (const m of MANAGED_MODELS) {
      if (m.transport === 'bedrock') {
        // Bedrock managed models are Claude via the Anthropic InvokeModel transport.
        expect(m.upstreamModelId, `${m.id} (Bedrock) → Anthropic`).toContain('anthropic.claude');
      } else {
        // OpenRouter slugs are provider/model.
        expect(m.transport, `${m.id} transport`).toBe('openrouter');
        expect(m.upstreamModelId, `${m.id} OpenRouter slug`).toContain('/');
      }
    }
  });
});

describe('managed resolution + back-compat aliases', () => {
  test('resolves current ids', () => {
    expect(getManagedModel('claude-opus-4.8')?.name).toBe('Claude Opus 4.8');
    expect(getManagedModel('claude-opus-4.8')?.transport).toBe('bedrock');
    expect(getManagedModel('glm-5.2')?.transport).toBe('openrouter');
    expect(getManagedModel('glm-5.2')?.upstreamModelId).toBe('z-ai/glm-5.2');
    expect(getManagedModel('qwen3.7-max')?.upstreamModelId).toBe('qwen/qwen3.7-max');
    expect(getManagedModel('deepseek-v4-pro')?.upstreamModelId).toBe('deepseek/deepseek-v4-pro');
  });

  test('retired branded ids still resolve (to the nearest current model) so stored configs do not break', () => {
    expect(getManagedModel('kortix-power')?.id).toBe('claude-sonnet-4.6');
    expect(getManagedModel('kortix-basic')?.id).toBe('claude-sonnet-4.6');
    expect(isManagedModelId('kortix-power')).toBe(true);
    expect(isManagedModelId('kortix-basic')).toBe(true);
  });

  test('superseded model ids resolve to their successor so stored configs do not break', () => {
    expect(getManagedModel('glm-4.6')?.id).toBe('glm-5.2');
    expect(getManagedModel('glm-4.7')?.id).toBe('glm-5.2');
    expect(getManagedModel('glm-5.1')?.id).toBe('glm-5.2'); // superseded — alias kept so stored configs don't break
    expect(getManagedModel('qwen3-max')?.id).toBe('qwen3.7-max');
    expect(getManagedModel('minimax-m2.5')?.id).toBe('claude-sonnet-4.6');
    expect(isManagedModelId('glm-4.6')).toBe(true);
    expect(isManagedModelId('glm-5.1')).toBe(true);
    expect(isManagedModelId('qwen3-max')).toBe(true);
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
