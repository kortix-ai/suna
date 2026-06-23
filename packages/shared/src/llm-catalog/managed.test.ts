import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MANAGED_MODEL_IDS,
  MANAGED_FLAGSHIP_MODEL_ID,
  MANAGED_MODELS,
  getManagedModel,
  isManagedModelId,
} from './index';

describe('managed catalog', () => {
  test('exposes the Bedrock-only lineup', () => {
    expect(DEFAULT_MANAGED_MODEL_IDS).toEqual([
      'claude-opus-4.8',
      'claude-sonnet-4.6',
      'deepseek-v3.2',
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

  test('every model runs on Bedrock with a pricing ref', () => {
    for (const m of MANAGED_MODELS) {
      expect(m.bedrockModelId.length, `${m.id} needs a Bedrock id`).toBeGreaterThan(0);
      expect(m.pricingRef.length, `${m.id} needs a pricing ref`).toBeGreaterThan(0);
    }
  });

  test('Anthropic models use the invoke transport, others use Converse', () => {
    for (const m of MANAGED_MODELS) {
      if (m.bedrockModelId.includes('anthropic.claude')) {
        expect(m.transport, `${m.id} (Anthropic) → invoke`).toBe('bedrock');
      } else {
        expect(m.transport, `${m.id} (non-Anthropic) → Converse`).toBe('bedrock-converse');
      }
    }
  });
});

describe('managed resolution + back-compat aliases', () => {
  test('resolves current ids', () => {
    expect(getManagedModel('claude-opus-4.8')?.name).toBe('Claude Opus 4.8');
    expect(getManagedModel('kimi-k2')?.bedrockModelId).toBe('moonshotai.kimi-k2.5');
    expect(getManagedModel('kimi-k2')?.transport).toBe('bedrock-converse');
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
