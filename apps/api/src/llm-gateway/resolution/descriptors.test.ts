import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realTiers from '../../billing/services/tiers';

const config: Record<string, unknown> = {
  KORTIX_MANAGED_PROVIDER_ENABLED: true,
  OPENROUTER_API_KEY: 'openrouter-test-key',
  OPENROUTER_API_URL: 'https://openrouter.ai/api/v1',
};
mock.module('../../config', () => ({ config }));
// Spread the real module — see the note in resolve-candidates.test.ts. Listing
// three exports by hand silently removed every other one from the registry.
mock.module('../../billing/services/tiers', () => ({
  ...realTiers,
  getTierEntitlements: () => ({}),
  llmPriceMarkup: () => 2,
  tierHasEntitlement: () => false,
}));

// Stand in for the live models.dev pricing cache (router/config/model-pricing)
// with a tiny fixed catalog keyed by BASE (unprefixed) Bedrock model ids —
// mirrors what models.dev actually publishes for Bedrock: it has never heard
// of a cross-region inference-profile id like `us.anthropic.claude-...`.
const CATALOG: Record<string, { inputPer1M: number; outputPer1M: number; cacheReadPer1M?: number; contextOver200k?: { inputPer1M: number; outputPer1M: number; cacheReadPer1M?: number; contextThreshold: number } }> = {
  'amazon-bedrock/anthropic.claude-opus-4-8': { inputPer1M: 15, outputPer1M: 75 },
  'amazon-bedrock/amazon.nova-micro-v1:0': { inputPer1M: 0.035, outputPer1M: 0.14 },
  'openrouter/x-ai/grok-4.6': {
    inputPer1M: 2,
    outputPer1M: 6,
    cacheReadPer1M: 0.5,
    contextOver200k: {
      inputPer1M: 4,
      outputPer1M: 12,
      cacheReadPer1M: 1,
      contextThreshold: 200_000,
    },
  },
};
const getModelPricing = mock(
  (providerId: string, modelId: string) => CATALOG[`${providerId}/${modelId}`] ?? null,
);
mock.module('../../router/config/model-pricing', () => ({ getModelPricing }));

const {
  bedrockByokBaseUrl,
  isAwsRegion,
  livePricing,
  managedCandidates,
  stripBedrockInferenceProfilePrefix,
  normalizeBedrockInferenceProfileRegion,
} = await import('./descriptors');

beforeEach(() => {
  getModelPricing.mockClear();
});

describe('stripBedrockInferenceProfilePrefix', () => {
  // The pricing lookup id: models.dev lists only the base Bedrock id.
  test.each([
    ['us.anthropic.claude-opus-4-8', 'anthropic.claude-opus-4-8'],
    ['eu.amazon.nova-micro-v1:0', 'amazon.nova-micro-v1:0'],
    ['apac.anthropic.claude-sonnet-4-6', 'anthropic.claude-sonnet-4-6'],
    ['us-gov.anthropic.claude-opus-4-8', 'anthropic.claude-opus-4-8'],
    // No prefix, a look-alike without the dot boundary, a region outside the
    // known set, and a bare prefix all pass through unchanged.
    ['anthropic.claude-opus-4-8', 'anthropic.claude-opus-4-8'],
    ['use.something', 'use.something'],
    ['usa.something', 'usa.something'],
    ['us-west-2.anthropic.claude-opus-4-8', 'us-west-2.anthropic.claude-opus-4-8'],
    ['us.', 'us.'],
  ])('%s → %s', (input, expected) => {
    expect(stripBedrockInferenceProfilePrefix(input)).toBe(expected);
  });
});

describe('normalizeBedrockInferenceProfileRegion', () => {
  test('rewrites a wrong-geography profile to the endpoint region (the jp.→us. incident)', () => {
    // Sessions on a us-east-1 box were pinned to jp.anthropic.claude-opus-5,
    // which Bedrock 400s "The provided model identifier is invalid."
    expect(
      normalizeBedrockInferenceProfileRegion('jp.anthropic.claude-opus-5', 'us-east-1'),
    ).toBe('us.anthropic.claude-opus-5');
  });

  test('maps each endpoint geography from its region (us / eu / apac / us-gov)', () => {
    expect(normalizeBedrockInferenceProfileRegion('jp.anthropic.claude-opus-5', 'us-west-2')).toBe(
      'us.anthropic.claude-opus-5',
    );
    expect(normalizeBedrockInferenceProfileRegion('jp.anthropic.claude-opus-5', 'eu-west-1')).toBe(
      'eu.anthropic.claude-opus-5',
    );
    expect(
      normalizeBedrockInferenceProfileRegion('us.anthropic.claude-opus-5', 'ap-northeast-1'),
    ).toBe('apac.anthropic.claude-opus-5');
    expect(
      normalizeBedrockInferenceProfileRegion('jp.anthropic.claude-opus-5', 'us-gov-east-1'),
    ).toBe('us-gov.anthropic.claude-opus-5');
  });

  test('is a no-op when the geography already matches the endpoint region', () => {
    expect(
      normalizeBedrockInferenceProfileRegion('us.anthropic.claude-sonnet-5', 'us-east-1'),
    ).toBe('us.anthropic.claude-sonnet-5');
  });

  test('leaves bare ids, global. profiles, and non-Anthropic families untouched', () => {
    expect(normalizeBedrockInferenceProfileRegion('anthropic.claude-opus-5', 'us-east-1')).toBe(
      'anthropic.claude-opus-5',
    );
    expect(
      normalizeBedrockInferenceProfileRegion('global.anthropic.claude-sonnet-5', 'us-east-1'),
    ).toBe('global.anthropic.claude-sonnet-5');
    expect(normalizeBedrockInferenceProfileRegion('jp.amazon.nova-pro-v1:0', 'us-east-1')).toBe(
      'jp.amazon.nova-pro-v1:0',
    );
  });

  test('skips normalization for an unrecognized region rather than guessing a prefix', () => {
    // ca-central-1 has no validated geography mapping → leave the id as-is.
    expect(
      normalizeBedrockInferenceProfileRegion('jp.anthropic.claude-opus-5', 'ca-central-1'),
    ).toBe('jp.anthropic.claude-opus-5');
  });

  test('falls back to the default BYOK region (us-east-1) when region is unset', () => {
    expect(normalizeBedrockInferenceProfileRegion('jp.anthropic.claude-opus-5', undefined)).toBe(
      'us.anthropic.claude-opus-5',
    );
    expect(normalizeBedrockInferenceProfileRegion('eu.anthropic.claude-opus-5', '')).toBe(
      'us.anthropic.claude-opus-5',
    );
  });
});

// The $0 upstream-cost bug: a cross-region profile id missed the catalog, so
// resolve-candidates strips the prefix before this lookup
// (resolve-candidates.test.ts asserts the stripped id reaches it).
describe('livePricing maps the catalog price onto the descriptor', () => {
  test('a flat price maps field by field', () => {
    expect(livePricing('amazon-bedrock', 'anthropic.claude-opus-4-8')).toEqual({
      inputPerMillion: 15,
      outputPerMillion: 75,
      cachedInputPerMillion: undefined,
      cacheWritePerMillion: undefined,
      tiers: undefined,
      contextOver200k: undefined,
    });
  });

  test('a long-context price maps its own tier', () => {
    expect(livePricing('openrouter', 'x-ai/grok-4.6')).toEqual({
      inputPerMillion: 2,
      outputPerMillion: 6,
      cachedInputPerMillion: 0.5,
      cacheWritePerMillion: undefined,
      tiers: undefined,
      contextOver200k: {
        inputPerMillion: 4,
        outputPerMillion: 12,
        cachedInputPerMillion: 1,
        cacheWritePerMillion: undefined,
        contextThreshold: 200_000,
      },
    });
  });

  test('a model the catalog does not list has no price', () => {
    expect(livePricing('amazon-bedrock', 'us.anthropic.claude-opus-4-8')).toBeUndefined();
  });
});

describe('managed OpenRouter descriptor', () => {
  test('routes DeepSeek through its pinned ZDR endpoint with Kortix credits', () => {
    expect(managedCandidates({
      id: 'deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash',
      upstreamModelId: 'deepseek/deepseek-v4.1-flash',
      transport: 'openrouter',
      pricingRef: 'openrouter/deepseek/deepseek-v4.1-flash',
      pricing: { inputPerMillion: 0.2, cachedInputPerMillion: 0.006, outputPerMillion: 0.6 },
      tier: 'balanced',
      vision: true,
      limit: { context: 1_048_576, output: 16_384 },
      openrouterProvider: { only: ['deepinfra/fp8'], allow_fallbacks: false, zdr: true, data_collection: 'deny' },
    })).toEqual([expect.objectContaining({
      provider: 'openrouter',
      kind: 'openai-compat',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'openrouter-test-key',
      resolvedModel: 'deepseek/deepseek-v4.1-flash',
      billingMode: 'credits',
      markup: 2,
      pricing: expect.objectContaining({
        inputPerMillion: 0.2,
        cachedInputPerMillion: 0.006,
        outputPerMillion: 0.6,
      }),
      bodyExtras: { provider: { only: ['deepinfra/fp8'], allow_fallbacks: false, zdr: true, data_collection: 'deny' } },
    })]);
  });
});

describe('managed Morph primary with OpenRouter pool fallback', () => {
  const glm = {
    id: 'glm-5.3-flash', name: 'GLM 5.3 Flash',
    upstreamModelId: 'z-ai/glm-5.3-flash', transport: 'openrouter' as const,
    morphModelId: 'morph-glm53flash',
    pricingRef: 'openrouter/z-ai/glm-5.3-flash',
    pricing: { inputPerMillion: 0.1, cachedInputPerMillion: 0.02, outputPerMillion: 0.35 },
    tier: 'fast' as const, vision: true, limit: { context: 1_048_576, output: 16_384 },
    openrouterProvider: {
      only: ['morph', 'wafer', 'together'], allow_fallbacks: true, zdr: true, data_collection: 'deny',
      max_price: { prompt: 0.15, completion: 0.5 },
    },
  };

  beforeEach(() => {
    config.MORPH_API_KEY = 'morph-test-key';
    config.MORPH_API_URL = 'https://api.morphllm.com/v1';
  });
  afterEach(() => {
    config.MORPH_API_KEY = undefined;
    config.MORPH_API_URL = undefined;
  });

  test('Morph is the first candidate and the OpenRouter pool is the failover', () => {
    expect(managedCandidates(glm)).toEqual([
      expect.objectContaining({
        provider: 'morph', kind: 'openai-compat', baseUrl: 'https://api.morphllm.com/v1',
        apiKey: 'morph-test-key', resolvedModel: 'morph-glm53flash', billingMode: 'credits', markup: 2,
        pricing: { inputPerMillion: 0.1, cachedInputPerMillion: 0.02, outputPerMillion: 0.35 },
        failover: true, publicProvider: 'kortix',
      }),
      expect.objectContaining({
        provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'openrouter-test-key',
        resolvedModel: 'z-ai/glm-5.3-flash', billingMode: 'credits', failover: true, publicProvider: 'kortix',
        bodyExtras: { provider: {
          only: ['morph', 'wafer', 'together'], allow_fallbacks: true, zdr: true, data_collection: 'deny',
          max_price: { prompt: 0.15, completion: 0.5 },
        } },
      }),
    ]);
    expect(managedCandidates(glm)[0].bodyExtras).toBeUndefined();
  });

  test('the OpenRouter route always forces ZDR and no data collection', () => {
    const [, openrouter] = managedCandidates({
      ...glm,
      openrouterProvider: { only: ['wafer'], allow_fallbacks: true, zdr: false, data_collection: 'allow' },
    });
    expect(openrouter.bodyExtras).toEqual({
      provider: { only: ['wafer'], allow_fallbacks: true, zdr: true, data_collection: 'deny' },
    });
  });

  test('without a Morph key the OpenRouter pool serves alone', () => {
    config.MORPH_API_KEY = undefined;
    expect(managedCandidates(glm).map((c) => c.provider)).toEqual(['openrouter']);
  });

  test('without an OpenRouter key Morph serves alone', () => {
    const saved = config.OPENROUTER_API_KEY;
    config.OPENROUTER_API_KEY = undefined;
    try {
      expect(managedCandidates(glm).map((c) => c.provider)).toEqual(['morph']);
    } finally { config.OPENROUTER_API_KEY = saved; }
  });

  test('a model without a Morph id routes through OpenRouter only', () => {
    const { morphModelId: _drop, ...openrouterOnly } = glm;
    expect(managedCandidates(openrouterOnly).map((c) => c.provider)).toEqual(['openrouter']);
  });
});

describe('bedrockByokBaseUrl', () => {
  test.each(['us-east-1', 'eu-central-2', 'ap-southeast-4', 'us-gov-west-1', 'il-central-1', 'ca-west-1'])(
    'accepts the region %s',
    (region) => {
      expect(isAwsRegion(region)).toBe(true);
      expect(bedrockByokBaseUrl(region)).toBe(`https://bedrock-runtime.${region}.amazonaws.com`);
    },
  );

  test.each(['x@example.test/', 'example.test#', 'us-east-1.example.test', 'us-east-1/', 'US-EAST-1', 'us_east_1', '10.0.0.5:8443'])(
    'refuses %s, which is not a region name',
    (region) => {
      expect(isAwsRegion(region)).toBe(false);
      expect(() => bedrockByokBaseUrl(region)).toThrow('AWS_REGION is not a valid AWS region name');
    },
  );

  test('an unset region uses us-east-1', () => {
    expect(bedrockByokBaseUrl(null)).toBe('https://bedrock-runtime.us-east-1.amazonaws.com');
    expect(bedrockByokBaseUrl('  ')).toBe('https://bedrock-runtime.us-east-1.amazonaws.com');
  });
});
