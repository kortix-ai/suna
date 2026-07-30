import { beforeEach, describe, expect, mock, test } from 'bun:test';

const config: Record<string, unknown> = {
  KORTIX_MANAGED_PROVIDER_ENABLED: true,
  ASTER_API_KEY: 'aster-test-key',
  ASTER_API_URL: 'https://api.asterlab.ai/v1',
};
mock.module('../../config', () => ({ config }));
mock.module('../../billing/services/tiers', () => ({ llmPriceMarkup: () => 2 }));

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

const { livePricing, managedCandidates, stripBedrockInferenceProfilePrefix } = await import(
  './descriptors'
);

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
