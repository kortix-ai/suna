import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Minimal config stub — none of the functions under test here read config
// fields, but descriptors.ts imports `config` at module scope (other
// exports in the file use it), so it must resolve to something.
const config: Record<string, unknown> = {};
mock.module('../../config', () => ({ config }));

// Stand in for the live models.dev pricing cache (router/config/model-pricing)
// with a tiny fixed catalog keyed by BASE (unprefixed) Bedrock model ids —
// mirrors what models.dev actually publishes for Bedrock: it has never heard
// of a cross-region inference-profile id like `us.anthropic.claude-...`.
const CATALOG: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  'anthropic.claude-opus-4-8': { inputPer1M: 15, outputPer1M: 75 },
  'amazon.nova-micro-v1:0': { inputPer1M: 0.035, outputPer1M: 0.14 },
};
const getModelPricing = mock((modelId: string) => CATALOG[modelId] ?? null);
mock.module('../../router/config/model-pricing', () => ({ getModelPricing }));

const { livePricing, stripBedrockInferenceProfilePrefix } = await import('./descriptors');

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
    expect(livePricing('us.anthropic.claude-opus-4-8')).toBeUndefined();
  });

  test('stripping the prefix first resolves the same catalog price as the base id', () => {
    const stripped = stripBedrockInferenceProfilePrefix('us.anthropic.claude-opus-4-8');
    expect(livePricing(stripped)).toEqual({
      inputPerMillion: 15,
      outputPerMillion: 75,
      cachedInputPerMillion: undefined,
      cacheWritePerMillion: undefined,
    });
    expect(livePricing(stripped)).toEqual(livePricing('anthropic.claude-opus-4-8'));
  });

  test('amazon.nova-micro cross-region id resolves via apac. prefix too', () => {
    const stripped = stripBedrockInferenceProfilePrefix('apac.amazon.nova-micro-v1:0');
    expect(livePricing(stripped)).toEqual(livePricing('amazon.nova-micro-v1:0'));
  });
});
