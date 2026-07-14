import { describe, expect, test } from 'bun:test';

import { envVarPlaceholder, helpHostnameFromUrl, prettyFieldLabel, releasedAgo } from './utils';

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
