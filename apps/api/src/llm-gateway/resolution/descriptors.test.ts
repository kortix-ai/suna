import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realTiers from '../../billing/services/tiers';

const config: Record<string, unknown> = {
  KORTIX_MANAGED_PROVIDER_ENABLED: true,
  ASTER_API_KEY: 'aster-test-key',
  ASTER_API_URL: 'https://api.asterlab.ai/v1',
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
const CATALOG: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  'amazon-bedrock/anthropic.claude-opus-4-8': { inputPer1M: 15, outputPer1M: 75 },
  'amazon-bedrock/amazon.nova-micro-v1:0': { inputPer1M: 0.035, outputPer1M: 0.14 },
};
const getModelPricing = mock(
  (providerId: string, modelId: string) => CATALOG[`${providerId}/${modelId}`] ?? null,
);
mock.module('../../router/config/model-pricing', () => ({ getModelPricing }));

const {
  livePricing,
  managedCandidates,
  stripBedrockInferenceProfilePrefix,
  normalizeBedrockInferenceProfileRegion,
} = await import('./descriptors');

beforeEach(() => {
  getModelPricing.mockClear();
});

describe('stripBedrockInferenceProfilePrefix', () => {
  test('strips the us. cross-region inference-profile prefix', () => {
    expect(stripBedrockInferenceProfilePrefix('us.anthropic.claude-opus-4-8')).toBe(
      'anthropic.claude-opus-4-8',
    );
  });

  test('strips the eu. prefix', () => {
    expect(stripBedrockInferenceProfilePrefix('eu.amazon.nova-micro-v1:0')).toBe(
      'amazon.nova-micro-v1:0',
    );
  });

  test('strips the apac. prefix', () => {
    expect(stripBedrockInferenceProfilePrefix('apac.anthropic.claude-sonnet-4-6')).toBe(
      'anthropic.claude-sonnet-4-6',
    );
  });

  test('strips the us-gov. prefix', () => {
    expect(stripBedrockInferenceProfilePrefix('us-gov.anthropic.claude-opus-4-8')).toBe(
      'anthropic.claude-opus-4-8',
    );
  });

  test('leaves a base id with no region prefix untouched', () => {
    expect(stripBedrockInferenceProfilePrefix('anthropic.claude-opus-4-8')).toBe(
      'anthropic.claude-opus-4-8',
    );
  });

  test('does not strip a look-alike id that merely starts with a prefix code but no matching dot boundary', () => {
    // "use." / "usa." aren't in the known-prefix set and don't match "us."
    // (the char after "us" isn't a dot), so they must pass through unchanged.
    expect(stripBedrockInferenceProfilePrefix('use.something')).toBe('use.something');
    expect(stripBedrockInferenceProfilePrefix('usa.something')).toBe('usa.something');
  });

  test('does not strip an unrelated region-like prefix outside the known AWS set', () => {
    expect(stripBedrockInferenceProfilePrefix('us-west-2.anthropic.claude-opus-4-8')).toBe(
      'us-west-2.anthropic.claude-opus-4-8',
    );
  });

  test('a bare prefix with nothing after the dot is left untouched (no empty result)', () => {
    expect(stripBedrockInferenceProfilePrefix('us.')).toBe('us.');
  });
});

describe('normalizeBedrockInferenceProfileRegion', () => {
  test('rewrites a wrong-geography profile to the endpoint region (the Essentia jp.→us. incident)', () => {
    // 41 sessions on a us-east-1 box were pinned to jp.anthropic.claude-opus-5,
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

describe('livePricing + stripBedrockInferenceProfilePrefix — the actual $0 bug', () => {
  test('a cross-region-prefixed id misses the catalog on its own (reproduces the bug)', () => {
    expect(livePricing('amazon-bedrock', 'us.anthropic.claude-opus-4-8')).toBeUndefined();
  });

  test('stripping the prefix first resolves the same catalog price as the base id', () => {
    const stripped = stripBedrockInferenceProfilePrefix('us.anthropic.claude-opus-4-8');
    expect(livePricing('amazon-bedrock', stripped)).toEqual({
      inputPerMillion: 15,
      outputPerMillion: 75,
      cachedInputPerMillion: undefined,
      cacheWritePerMillion: undefined,
      tiers: undefined,
      contextOver200k: undefined,
    });
    expect(livePricing('amazon-bedrock', stripped)).toEqual(
      livePricing('amazon-bedrock', 'anthropic.claude-opus-4-8'),
    );
  });

  test('amazon.nova-micro cross-region id resolves via apac. prefix too', () => {
    const stripped = stripBedrockInferenceProfilePrefix('apac.amazon.nova-micro-v1:0');
    expect(livePricing('amazon-bedrock', stripped)).toEqual(
      livePricing('amazon-bedrock', 'amazon.nova-micro-v1:0'),
    );
  });
});

describe('managed AsterLab descriptor', () => {
  test('routes GLM 5.2 to AsterLab with the AWS-managed deployment credential', () => {
    expect(
      managedCandidates({
        id: 'glm-5.2',
        name: 'GLM 5.2',
        upstreamModelId: 'glm-5.2',
        transport: 'aster',
        pricingRef: 'z-ai/glm-5.2',
        pricing: {
          inputPerMillion: 1,
          cachedInputPerMillion: 0.2,
          cacheWritePerMillion: 1,
          outputPerMillion: 4,
        },
        tier: 'balanced',
        vision: false,
        limit: { context: 1_000_000, output: 131_072 },
      }),
    ).toEqual([
      expect.objectContaining({
        provider: 'aster',
        kind: 'openai-compat',
        baseUrl: 'https://api.asterlab.ai/v1',
        apiKey: 'aster-test-key',
        resolvedModel: 'glm-5.2',
        billingMode: 'credits',
        pricing: {
          inputPerMillion: 1,
          cachedInputPerMillion: 0.2,
          cacheWritePerMillion: 1,
          outputPerMillion: 4,
        },
      }),
    ]);
  });
});
