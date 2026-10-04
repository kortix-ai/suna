import { describe, expect, test } from 'bun:test';

import {
  canonicalManagedModelId,
  isRetiredManagedModelId,
  LEGACY_MANAGED_IDS,
  type ManagedModel,
  parseManagedModels,
  resolveLegacyIdChain,
  resolvePlatformDefaultModelId,
  retiredManagedModelReplacement,
} from './managed-models';

describe('runtime managed model registry', () => {
  test('accepts a complete operator-defined managed-model replacement', () => {
    const configured = parseManagedModels(JSON.stringify([{
      id: 'operator-model',
      name: 'Operator Model',
      upstreamModelId: 'morph-model-v2',
      transport: 'openrouter',
      pricingRef: 'openrouter/morph-model-v2',
      openrouterProvider: { only: ['test-endpoint'], allow_fallbacks: false, zdr: true, data_collection: 'deny' },
      tier: 'balanced',
      vision: true,
      limit: { context: 64_000, output: 8_000 },
    }]));

    expect(configured).toEqual([expect.objectContaining({
      id: 'operator-model',
      upstreamModelId: 'morph-model-v2',
      vision: true,
    })]);
  });

  test('keeps text-only models in operator overlays', () => {
    const vision = {
      id: 'vision', name: 'Vision', upstreamModelId: 'z-ai/glm-5.3-flash',
      transport: 'openrouter', pricingRef: 'openrouter/z-ai/glm-5.3-flash',
      openrouterProvider: { only: ['test-endpoint'], allow_fallbacks: false, zdr: true, data_collection: 'deny' },
      tier: 'fast', vision: true, limit: { context: 1_000, output: 100 },
    };
    expect(parseManagedModels(JSON.stringify([{ ...vision, id: 'text', vision: false }, vision])))
      .toEqual([expect.objectContaining({ id: 'text', vision: false }), expect.objectContaining({ id: 'vision' })]);
  });

  test('accepts a ZDR OpenRouter pool without a direct upstream', () => {
    const pooled = {
      id: 'pooled', name: 'Pooled', upstreamModelId: 'z-ai/glm-5.3-flash',
      transport: 'openrouter', pricingRef: 'openrouter/z-ai/glm-5.3-flash',
      tier: 'fast', vision: true, limit: { context: 1_000, output: 100 },
      openrouterProvider: {
        only: ['decart/fp4', 'coreweave/nvfp4'], allow_fallbacks: true, zdr: true, data_collection: 'deny',
        max_price: { prompt: 0.15, completion: 0.5 },
      },
    };
    expect(parseManagedModels(JSON.stringify([pooled]))).toMatchObject([pooled]);
    const withMorph = { ...pooled, morphModelId: 'morph-glm53flash',
      morphPricing: { inputPerMillion: 0.1, outputPerMillion: 0.35 } };
    expect(parseManagedModels(JSON.stringify([withMorph]))).toMatchObject([withMorph]);
    expect(() => parseManagedModels(JSON.stringify([{ ...pooled, morphModelId: 'morph-glm53flash' }]))).toThrow();
    expect(() => parseManagedModels(JSON.stringify([{ ...pooled, morphPricing: withMorph.morphPricing }]))).toThrow();
  });

  test('rejects an unrestricted, non-ZDR, or data-collecting operator route', () => {
    const model = {
      id: 'unsafe', name: 'Unsafe', upstreamModelId: 'z-ai/glm-5.3-flash',
      transport: 'openrouter', pricingRef: 'openrouter/z-ai/glm-5.3-flash',
      tier: 'fast', vision: true, limit: { context: 1_000, output: 100 },
    };
    const route = { only: ['coreweave/nvfp4'], allow_fallbacks: true, zdr: true, data_collection: 'deny' };
    expect(() => parseManagedModels(JSON.stringify([model]))).toThrow();
    for (const unsafe of [
      { ...route, only: [] },
      { allow_fallbacks: true, zdr: true, data_collection: 'deny' },
      { ...route, zdr: false },
      { ...route, data_collection: 'allow' },
    ]) {
      expect(() => parseManagedModels(JSON.stringify([{ ...model, openrouterProvider: unsafe }]))).toThrow();
    }
    expect(() => parseManagedModels(JSON.stringify([{ ...model, morphModelId: '', openrouterProvider: route }]))).toThrow();
  });

  test('rejects an unknown managed transport', () => {
    expect(() => parseManagedModels(JSON.stringify([{
      id: 'retired-model',
      name: 'Retired Model',
      upstreamModelId: 'retired-model',
      transport: 'aster',
      pricingRef: 'vendor/retired-model',
      // A valid route, so the transport is the only fault.
      openrouterProvider: { only: ['test-endpoint'], allow_fallbacks: false, zdr: true, data_collection: 'deny' },
      tier: 'balanced',
      vision: false,
      limit: { context: 1_000, output: 1_000 },
    }]))).toThrow();
  });

  test('rejects malformed and duplicate managed-model definitions', () => {
    expect(() => parseManagedModels('{broken')).toThrow('must be valid JSON');
    const duplicate = {
      id: 'same',
      name: 'Same',
      upstreamModelId: 'morph-same',
      transport: 'openrouter',
      pricingRef: 'openrouter/morph-same',
      openrouterProvider: { only: ['test-endpoint'], allow_fallbacks: false, zdr: true, data_collection: 'deny' },
      tier: 'fast',
      vision: false,
      limit: { context: 1, output: 1 },
    };
    expect(() => parseManagedModels(JSON.stringify([duplicate, duplicate]))).toThrow('duplicate');
  });
});

const managed = (
  id: string,
  transport: ManagedModel['transport'],
  tier: ManagedModel['tier'] = 'balanced',
): ManagedModel => ({
  id,
  name: id,
  upstreamModelId: id,
  transport,
  pricingRef: id,
  tier,
  vision: false,
  limit: { context: 1_000, output: 1_000 },
});

describe('resolvePlatformDefaultModelId — the platform default must always be reachable', () => {
  const lineup = [
    managed('kimi-k3', 'openrouter', 'flagship'),
    managed('morph-dsv4flash', 'openrouter', 'fast'),
  ];

  test('keeps the configured default when it is actually served', () => {
    const served = [managed('morph-glm53-744b', 'openrouter'), ...lineup];
    expect(resolvePlatformDefaultModelId('morph-glm53-744b', served)).toBe('morph-glm53-744b');
  });

  test('maps an old Morph default to the equivalent served model', () => {
    expect(resolvePlatformDefaultModelId('morph-kimik3', lineup)).toBe('kimi-k3');
    const deepseek = managed('deepseek-v4.1-flash', 'openrouter');
    expect(resolvePlatformDefaultModelId('kortix/morph-dsv41flash', [deepseek])).toBe('deepseek-v4.1-flash');
  });

  test('falls back to the served flagship when the configured default is unreachable', () => {
    expect(resolvePlatformDefaultModelId('morph-glm53-744b', lineup)).toBe('kimi-k3');
  });

  test('accepts and preserves the opencode `kortix/<id>` ref form', () => {
    expect(resolvePlatformDefaultModelId('kortix/morph-glm53-744b', lineup)).toBe('kimi-k3');
    const served = [managed('morph-glm53-744b', 'openrouter'), ...lineup];
    expect(resolvePlatformDefaultModelId('kortix/morph-glm53-744b', served)).toBe('kortix/morph-glm53-744b');
  });

  test('falls back to the first served model when no flagship is served', () => {
    const noFlagship = [managed('morph-dsv4flash', 'openrouter', 'fast')];
    expect(resolvePlatformDefaultModelId('morph-glm53-744b', noFlagship)).toBe('morph-dsv4flash');
  });

  test('leaves a BYOK default untouched — it resolves from a project key, not a managed transport', () => {
    expect(resolvePlatformDefaultModelId('anthropic/claude-opus-4-8', lineup)).toBe(
      'anthropic/claude-opus-4-8',
    );
  });

  test('leaves the configured default unchanged when nothing managed is served at all', () => {
    expect(resolvePlatformDefaultModelId('morph-glm53-744b', [])).toBe('morph-glm53-744b');
    expect(resolvePlatformDefaultModelId('', [])).toBe('');
  });
});

describe('isRetiredManagedModelId', () => {
  test('the two ids from the 2026-09-28 sweep are retired', () => {
    expect(isRetiredManagedModelId('deepseek-v4-flash-0731')).toBe(true);
    expect(isRetiredManagedModelId('grok-4.6')).toBe(true);
  });

  test('a current lineup id is not retired', () => {
    expect(isRetiredManagedModelId('deepseek-v4.1-flash')).toBe(false);
    expect(isRetiredManagedModelId('glm-5.3-flash')).toBe(false);
    expect(isRetiredManagedModelId('kimi-k3')).toBe(false);
  });

  test('an id this catalog has never heard of is not retired — it is simply unknown', () => {
    expect(isRetiredManagedModelId('not-a-real-model')).toBe(false);
  });
});

describe('deepseek-v4-flash-0731 declares deepseek-v4.1-flash as its successor', () => {
  test('canonicalManagedModelId resolves it', () => {
    expect(canonicalManagedModelId('deepseek-v4-flash-0731')).toBe('deepseek-v4.1-flash');
  });

  // deepseek-v4-flash-0731 is ITSELF the one-hop target of two older aliases —
  // a single lookup would leave morph-dsv4flash/deepseek-v4-flash pointing at
  // a now-also-retired id. canonicalManagedModelId must follow the full chain.
  test('a two-hop alias (morph-dsv4flash / deepseek-v4-flash) resolves through it, not to it', () => {
    expect(canonicalManagedModelId('morph-dsv4flash')).toBe('deepseek-v4.1-flash');
    expect(canonicalManagedModelId('deepseek-v4-flash')).toBe('deepseek-v4.1-flash');
  });
});

// The guard against this exact class of bug recurring: someone retires a
// model that is itself the declared successor of an older alias, and does not
// revisit that alias. Every entry in the map must resolve — however many hops
// it takes — to something that is NOT ALSO retired.
describe('every LEGACY_MANAGED_IDS chain resolves off of a retired id', () => {
  for (const alias of Object.keys(LEGACY_MANAGED_IDS)) {
    test(`"${alias}" -> ... -> a non-retired id`, () => {
      const resolved = canonicalManagedModelId(alias);
      expect(isRetiredManagedModelId(resolved)).toBe(false);
      // Idempotent: a true fixed point, not an intermediate hop left behind
      // by the bound or a cycle guard.
      expect(canonicalManagedModelId(resolved)).toBe(resolved);
    });
  }
});

describe('resolveLegacyIdChain is bounded and cycle-safe (synthetic tables — the real map is never mutated)', () => {
  test('a direct cycle stops instead of looping forever', () => {
    const cyclic = { a: 'b', b: 'a' };
    // Enters the cycle at 'a' -> 'b' -> 'a' (seen) -> stops at 'b'.
    expect(resolveLegacyIdChain('a', cyclic)).toBe('b');
  });

  test('a self-referencing entry stops immediately', () => {
    expect(resolveLegacyIdChain('a', { a: 'a' })).toBe('a');
  });

  test('a chain longer than the hop bound stops rather than hanging', () => {
    const long: Record<string, string> = {};
    for (let i = 0; i < 20; i++) long[`chain-${i}`] = `chain-${i + 1}`;
    const resolved = resolveLegacyIdChain('chain-0', long, 8);
    expect(resolved).not.toBe('chain-20'); // never reaches the true (unbounded) end
    expect(resolved.startsWith('chain-')).toBe(true); // stopped mid-chain, not a wrong answer
  });

  test('a chain within the bound fully resolves', () => {
    const short = { a: 'b', b: 'c', c: 'd' };
    expect(resolveLegacyIdChain('a', short, 8)).toBe('d');
  });
});

describe('retiredManagedModelReplacement', () => {
  const lineup = [managed('deepseek-v4.1-flash', 'openrouter'), managed('kimi-k3', 'openrouter')];

  test('names the declared successor when it is actually served', () => {
    expect(retiredManagedModelReplacement('deepseek-v4-flash-0731', lineup)).toBe('deepseek-v4.1-flash');
  });

  test('returns null when the declared successor is not itself served here', () => {
    expect(retiredManagedModelReplacement('deepseek-v4-flash-0731', [managed('kimi-k3', 'openrouter')])).toBeNull();
  });

  test('returns null when there is no declared successor at all', () => {
    expect(retiredManagedModelReplacement('grok-4.6', lineup)).toBeNull();
  });

  test('returns null for an id that was never retired', () => {
    expect(retiredManagedModelReplacement('kimi-k3', lineup)).toBeNull();
  });
});
