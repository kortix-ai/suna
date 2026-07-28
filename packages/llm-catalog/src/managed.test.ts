import { describe, expect, test } from 'bun:test';
import {
  CATALOG,
  DEFAULT_MANAGED_MODEL_IDS,
  MANAGED_FLAGSHIP_MODEL_ID,
  MANAGED_MODELS,
  getManagedModel,
  isManagedModelId,
  pricingRefLookupCandidates,
} from './index';

describe('managed catalog', () => {
  test('exposes the managed lineup', () => {
    expect(DEFAULT_MANAGED_MODEL_IDS).toEqual([
      'claude-opus-4.8',
      'claude-sonnet-4.6',
      'glm-5.2',
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
      expect(['aster', 'bedrock', 'openrouter']).toContain(m.transport);
    }
  });

  // MUST-FIX regression (adversarial review of PR #4995): claude-opus-4.8 and
  // claude-sonnet-4.6's `pricingRef` used to be the DOTTED display id
  // ('anthropic/claude-opus-4.8'), which never matches models.dev's DASHED
  // catalog id ('claude-opus-4-8') — every consumer's pricing/capability
  // lookup by `pricingRef` silently missed and fell back to a permissive
  // synthetic record. Guard the SOURCE OF TRUTH directly for the Claude
  // (bedrock-transport) managed models specifically — unlike glm-5.2 and
  // deepseek-v4-flash, whose `pricingRef` is DELIBERATELY unresolvable
  // on models.dev under a matching provider id (z-ai≠zhipuai, qwen≠alibaba —
  // see the `vision`/`limit` doc comment above), Claude's pricingRef SHOULD
  // always resolve since `anthropic` is a real models.dev provider id.
  test('Claude managed models pricingRef resolves to a real live catalog entry', () => {
    const byRef = new Map<string, unknown>();
    for (const provider of CATALOG.providers) {
      for (const model of provider.models) byRef.set(`${provider.id}/${model.id}`, model);
    }
    for (const m of MANAGED_MODELS.filter((m) => m.transport === 'bedrock')) {
      const hit = pricingRefLookupCandidates(m.pricingRef).some((ref) => byRef.has(ref));
      expect(hit, `${m.id}'s pricingRef "${m.pricingRef}" should resolve on models.dev`).toBe(true);
    }
  });

  test('transport matches the upstream id shape', () => {
    for (const m of MANAGED_MODELS) {
      if (m.transport === 'bedrock') {
        // Bedrock managed models are Claude via the Anthropic InvokeModel transport.
        expect(m.upstreamModelId, `${m.id} (Bedrock) → Anthropic`).toContain('anthropic.claude');
      } else if (m.transport === 'openrouter') {
        // OpenRouter slugs are provider/model.
        expect(m.upstreamModelId, `${m.id} OpenRouter slug`).toContain('/');
      } else {
        expect(m.transport, `${m.id} transport`).toBe('aster');
        expect(m.upstreamModelId, `${m.id} AsterLab model`).toBe('glm-5.2');
      }
    }
  });

  test('OpenRouter free slugs are not managed Kortix defaults', () => {
    for (const id of ['north-mini-code-free', 'nemotron-3-ultra-free']) {
      expect(getManagedModel(id), `${id} should not resolve`).toBeUndefined();
      expect(isManagedModelId(id), `${id} should not be managed`).toBe(false);
    }
  });
});

describe('managed resolution + back-compat aliases', () => {
  test('resolves current ids', () => {
    expect(getManagedModel('claude-opus-4.8')?.name).toBe('Claude Opus 4.8');
    expect(getManagedModel('claude-opus-4.8')?.transport).toBe('bedrock');
    expect(getManagedModel('glm-5.2')?.name).toBe('GLM 5.2');
    expect(getManagedModel('glm-5.2')?.transport).toBe('aster');
    expect(getManagedModel('glm-5.2')?.upstreamModelId).toBe('glm-5.2');
    expect(getManagedModel('glm-5.2')?.pricing).toEqual({
      inputPerMillion: 1,
      cachedInputPerMillion: 0.2,
      cacheWritePerMillion: 1,
      outputPerMillion: 4,
    });
    expect(getManagedModel('deepseek-v4-flash')?.providerBrand).toBe('deepseek');
    expect(getManagedModel('deepseek-v4-flash')?.pricing).toEqual({
      inputPerMillion: 0.0938,
      cachedInputPerMillion: 0.01876,
      cacheWritePerMillion: 0.0938,
      outputPerMillion: 0.1876,
    });
  });

  test('retired / superseded model ids no longer resolve (aliases removed)', () => {
    for (const old of [
      'kortix-power',
      'kortix-basic',
      'glm-4.6',
      'glm-5.1',
      'fusion',
      'qwen3-max',
      'minimax-m2.5',
      'kimi-k2',
    ]) {
      expect(getManagedModel(old), `${old} should be gone`).toBeUndefined();
      expect(isManagedModelId(old), `${old} should be gone`).toBe(false);
    }
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
