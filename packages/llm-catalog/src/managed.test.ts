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
  // 2026-08-10: claude-opus-4.8 / claude-sonnet-4.6 / kimi-k3 deactivated
  // (commented out in MANAGED_MODELS, reactivatable by diff); muse-spark-1.2,
  // minimax-m3, and gpt-5.6-luna added the same day. 2026-08-27: glm-5.3-flash
  // (OpenRouter, Z.ai first-party) added.
  test('exposes the managed lineup', () => {
    expect(DEFAULT_MANAGED_MODEL_IDS).toEqual([
      'grok-4.6',
      'glm-5.2',
      'deepseek-v4-flash',
      'deepseek-v4-pro-0813',
      'muse-spark-1.2',
      'minimax-m3',
      'gpt-5.6-luna',
      'glm-5.3-flash',
    ]);
  });

  test('the haiku/sonnet branded ids are gone from the served catalog', () => {
    expect(DEFAULT_MANAGED_MODEL_IDS).not.toContain('kortix-power');
    expect(DEFAULT_MANAGED_MODEL_IDS).not.toContain('kortix-basic');
  });

  test('Grok 4.6 is the single flagship', () => {
    expect(MANAGED_FLAGSHIP_MODEL_ID).toBe('grok-4.6');
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

  // Measured 2026-07-30 on live session fcfd1f38-5e64-4a65-9db1-78cb5a6a4690:
  // `deepseek/deepseek-v4-flash` is served by 21 OpenRouter endpoints. With NO
  // `provider` routing preference on the request, OpenRouter load-balances
  // across all of them, and they are not interchangeable:
  //   - exactly ONE (`deepseek`, the first-party endpoint) reports
  //     supports_implicit_caching:true, so the prompt cache is a ~1-in-21
  //     lottery — replaying a BYTE-IDENTICAL body twice measured 0% then 99%
  //     cached, which is what made `cachedReadTokens` look like it collapsed
  //     after turn 1 when the prefix had never changed at all;
  //   - `io-net/fp8` caps context at 32_768 and `akashml/fp8` at 131_072
  //     against a model advertised at 1_048_576, so a long session can be
  //     routed onto an endpoint that cannot hold it;
  //   - `coreweave/fp8` publishes a p99 latency of 107_688ms;
  //   - identical input tokenizes differently per endpoint (7041 / 7066 /
  //     7081 / 7361 prompt_tokens for the same body).
  // `openrouterProvider` exists for exactly this and was set on ZERO models.
  test('every openrouter-transport managed model pins its provider routing', () => {
    const openRouterModels = MANAGED_MODELS.filter((m) => m.transport === 'openrouter');
    expect(openRouterModels.length).toBeGreaterThan(0);
    for (const m of openRouterModels) {
      const pref = m.openrouterProvider;
      expect(pref, `${m.id} must pin OpenRouter provider routing`).toBeDefined();
      const order = (pref as { order?: unknown }).order;
      expect(Array.isArray(order), `${m.id} needs a provider order`).toBe(true);
      expect((order as string[]).length, `${m.id} needs a provider order`).toBeGreaterThan(0);
      // Fallbacks stay ON: pinning must improve cache locality without turning
      // a single endpoint's outage into a hard failure for the whole platform.
      expect(
        (pref as { allow_fallbacks?: unknown }).allow_fallbacks,
        `${m.id} must keep OpenRouter fallbacks enabled`,
      ).toBe(true);
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
        // AsterLab accepts a bare, slash-free upstream model id on its
        // OpenAI-compatible endpoint (e.g. `glm-5.2`, `kimi-k3`).
        expect(m.transport, `${m.id} transport`).toBe('aster');
        expect(m.upstreamModelId, `${m.id} AsterLab slug`).toMatch(/^[^/]+$/);
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
    expect(getManagedModel('glm-5.2')?.name).toBe('GLM 5.2');
    expect(getManagedModel('glm-5.2')?.transport).toBe('aster');
    expect(getManagedModel('glm-5.2')?.upstreamModelId).toBe('glm-5.2');
    expect(getManagedModel('glm-5.2')?.pricing).toEqual({
      inputPerMillion: 1,
      cachedInputPerMillion: 0.2,
      cacheWritePerMillion: 1,
      outputPerMillion: 4,
    });
    expect(getManagedModel('deepseek-v4-flash')?.providerBrand).toBeUndefined();
    expect(getManagedModel('deepseek-v4-flash')?.pricing).toEqual({
      inputPerMillion: 0.0938,
      cachedInputPerMillion: 0.01876,
      cacheWritePerMillion: 0.0938,
      outputPerMillion: 0.1876,
    });
    expect(getManagedModel('grok-4.6')).toMatchObject({
      name: 'Grok 4.6',
      upstreamModelId: 'x-ai/grok-4.6',
      transport: 'openrouter',
      pricingRef: 'openrouter/x-ai/grok-4.6',
      tier: 'flagship',
      vision: true,
      limit: { context: 500_000, output: 500_000 },
      openrouterProvider: { order: ['xai'], allow_fallbacks: true },
    });
    expect(getManagedModel('grok-4.6')?.pricing).toEqual({
      inputPerMillion: 2,
      cachedInputPerMillion: 0.5,
      outputPerMillion: 6,
      contextOver200k: {
        inputPerMillion: 4,
        cachedInputPerMillion: 1,
        outputPerMillion: 12,
        contextThreshold: 200_000,
      },
    });
    expect(getManagedModel('deepseek-v4-pro-0813')).toMatchObject({
      name: 'DeepSeek V4 Pro 0813',
      upstreamModelId: 'deepseek/deepseek-v4-pro-0813',
      transport: 'openrouter',
      pricingRef: 'openrouter/deepseek/deepseek-v4-pro-0813',
      pricing: {
        inputPerMillion: 1.74,
        cachedInputPerMillion: 0.145,
        outputPerMillion: 3.48,
      },
      tier: 'balanced',
      vision: false,
      limit: { context: 1_048_575, output: 384_000 },
      openrouterProvider: {
        order: ['gmicloud'],
        allow_fallbacks: true,
      },
    });
    // Measured 2026-08-27 on OpenRouter: z-ai (first-party) + novita at
    // $0.075/$0.25/$0.015, 1_048_576 ctx / 131_072 out; gmicloud degraded
    // (status -2, 86.9% uptime) and ignored. Vision: models.dev lists
    // text+image+video input.
    expect(getManagedModel('glm-5.3-flash')).toMatchObject({
      name: 'GLM 5.3 Flash',
      upstreamModelId: 'z-ai/glm-5.3-flash',
      transport: 'openrouter',
      pricingRef: 'openrouter/z-ai/glm-5.3-flash',
      pricing: {
        inputPerMillion: 0.075,
        cachedInputPerMillion: 0.015,
        outputPerMillion: 0.25,
      },
      tier: 'fast',
      vision: true,
      limit: { context: 1_048_576, output: 131_072 },
      openrouterProvider: {
        order: ['z-ai', 'novita'],
        ignore: ['gmicloud'],
        allow_fallbacks: true,
      },
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
      // 2026-08-10 slim-down (commented out, not aliased):
      'claude-opus-4.8',
      'claude-sonnet-4.6',
      'kimi-k3',
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
