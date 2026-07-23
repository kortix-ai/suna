import { describe, expect, test } from 'bun:test';

import {
  envVarPlaceholder,
  formatPricePerMillion,
  formatTokenCount,
  gatewayModelId,
  helpHostnameFromUrl,
  prettyFieldLabel,
  releasedAgo,
} from './utils';

describe('gatewayModelId', () => {
  test('BYOK provider gets a provider/model wire id', () => {
    expect(gatewayModelId({ id: 'anthropic', managed: false }, 'claude-sonnet-4.6')).toBe(
      'anthropic/claude-sonnet-4.6',
    );
  });

  test('managed Kortix provider stays bare (single-segment)', () => {
    expect(gatewayModelId({ id: 'kortix', managed: true }, 'claude-opus-4.8')).toBe(
      'claude-opus-4.8',
    );
  });

  test('codex (ChatGPT subscription) gets a codex/ prefix', () => {
    expect(gatewayModelId({ id: 'codex', managed: false }, 'gpt-5.6-sol')).toBe(
      'codex/gpt-5.6-sol',
    );
  });
});

describe('formatTokenCount', () => {
  test('formats millions with a decimal only when not whole', () => {
    expect(formatTokenCount(1_000_000)).toBe('1M');
    expect(formatTokenCount(1_500_000)).toBe('1.5M');
  });

  test('formats thousands rounded to the nearest K', () => {
    expect(formatTokenCount(128_000)).toBe('128K');
    expect(formatTokenCount(8_192)).toBe('8K');
  });

  test('formats sub-1000 values verbatim', () => {
    expect(formatTokenCount(512)).toBe('512');
  });

  test('returns empty string for falsy or non-positive input', () => {
    expect(formatTokenCount(undefined)).toBe('');
    expect(formatTokenCount(null)).toBe('');
    expect(formatTokenCount(0)).toBe('');
    expect(formatTokenCount(-5)).toBe('');
  });
});

describe('formatPricePerMillion', () => {
  test('formats whole-dollar rates with two decimals', () => {
    expect(formatPricePerMillion(3)).toBe('$3.00');
    expect(formatPricePerMillion(15)).toBe('$15.00');
  });

  test('formats sub-dollar rates with three decimals', () => {
    expect(formatPricePerMillion(0.25)).toBe('$0.250');
  });

  test('formats sub-cent rates with four decimals', () => {
    expect(formatPricePerMillion(0.0007)).toBe('$0.0007');
  });

  test('zero rate reads as Free', () => {
    expect(formatPricePerMillion(0)).toBe('Free');
  });

  test('returns empty string when the rate is unknown', () => {
    expect(formatPricePerMillion(null)).toBe('');
    expect(formatPricePerMillion(undefined)).toBe('');
  });
});

describe('helpHostnameFromUrl', () => {
  test('strips the leading www and scheme', () => {
    expect(helpHostnameFromUrl('https://www.anthropic.com/docs')).toBe('anthropic.com');
    expect(helpHostnameFromUrl('https://developers.openai.com/codex/auth')).toBe(
      'developers.openai.com',
    );
  });

  test('returns null for missing or unparseable URLs', () => {
    expect(helpHostnameFromUrl(null)).toBeNull();
    expect(helpHostnameFromUrl('not a url')).toBeNull();
  });
});

describe('releasedAgo', () => {
  test('formats recent dates as days, weeks, months, or years', () => {
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    expect(releasedAgo(daysAgo(0))).toBe('today');
    expect(releasedAgo(daysAgo(3))).toBe('3d');
    expect(releasedAgo(daysAgo(14))).toBe('2w');
    expect(releasedAgo(daysAgo(90))).toBe('3mo');
    expect(releasedAgo(daysAgo(400))).toBe('1y');
  });

  test('returns an empty string for an unparseable date', () => {
    expect(releasedAgo('not-a-date')).toBe('');
  });
});

describe('prettyFieldLabel', () => {
  test('turns a provider-prefixed env var into a friendly label', () => {
    expect(prettyFieldLabel('ANTHROPIC_API_KEY')).toBe('API key');
    expect(prettyFieldLabel('CUSTOM_BASE_URL')).toBe('Base URL');
    expect(prettyFieldLabel('AZURE_RESOURCE_NAME')).toBe('Resource name');
  });
});

describe('envVarPlaceholder', () => {
  const provider = {
    id: 'anthropic',
    label: 'Anthropic',
    envVars: ['ANTHROPIC_API_KEY'],
    authRequirement: { methods: [{ envVars: ['ANTHROPIC_API_KEY'] }] },
    helpUrl: null,
    hint: '',
    models: [],
    featured: true,
  };

  test('references the provider by name for a single-field form', () => {
    expect(envVarPlaceholder(provider, 'ANTHROPIC_API_KEY')).toBe('Paste your Anthropic API key…');
  });

  test('falls back to the raw env var name for multi-field forms', () => {
    const multi = { ...provider, envVars: ['AZURE_API_KEY', 'AZURE_RESOURCE_NAME'] };
    expect(envVarPlaceholder(multi, 'AZURE_RESOURCE_NAME')).toBe('Enter AZURE_RESOURCE_NAME…');
  });
});
