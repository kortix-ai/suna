import { describe, expect, test } from 'bun:test';

import {
  capabilityCount,
  hasCapabilities,
} from './marketplace-install';
import { buildTemplateSetupPrompt } from './marketplace-setup-prompt';

describe('buildTemplateSetupPrompt', () => {
  test('tells template setup sessions to read install.md when present', () => {
    const prompt = buildTemplateSetupPrompt('SEO Department');

    expect(prompt).toContain('install.md');
    expect(prompt).toContain('template-specific setup guide');
  });
});

describe('hasCapabilities', () => {
  test('false for null/undefined', () => {
    expect(hasCapabilities(null)).toBe(false);
    expect(hasCapabilities(undefined)).toBe(false);
  });

  test('false when every list is empty', () => {
    expect(hasCapabilities({ secrets: [], connectors: [], tools: [], network: [] })).toBe(false);
  });

  test('true when any list is non-empty', () => {
    expect(hasCapabilities({ secrets: ['API_KEY'], connectors: [], tools: [], network: [] })).toBe(
      true,
    );
    expect(hasCapabilities({ secrets: [], connectors: ['slack'], tools: [], network: [] })).toBe(
      true,
    );
    expect(hasCapabilities({ secrets: [], connectors: [], tools: ['browser'], network: [] })).toBe(
      true,
    );
  });
});

describe('capabilityCount', () => {
  test('0 for null/undefined', () => {
    expect(capabilityCount(null)).toBe(0);
    expect(capabilityCount(undefined)).toBe(0);
  });

  test('sums across all three kinds', () => {
    expect(
      capabilityCount({
        secrets: ['A', 'B'],
        connectors: ['c'],
        tools: ['t1', 't2', 't3'],
        network: [],
      }),
    ).toBe(6);
  });
});
