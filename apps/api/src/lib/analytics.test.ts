import { afterEach, describe, expect, test } from 'bun:test';

import {
  identifyAccount,
  providerForSecretName,
  requestSource,
  setAnalyticsClientForTests,
  shutdownAnalytics,
  track,
} from './analytics';

function fakeClient() {
  const captured: unknown[] = [];
  const groups: unknown[] = [];
  let shutdowns = 0;
  return {
    captured,
    groups,
    get shutdowns() {
      return shutdowns;
    },
    client: {
      capture: (m: unknown) => {
        captured.push(m);
      },
      groupIdentify: (m: unknown) => {
        groups.push(m);
      },
      shutdown: async () => {
        shutdowns += 1;
      },
    },
  };
}

function ctx(headers: Record<string, string>, vars: Record<string, string | undefined> = {}) {
  return {
    req: { header: (name: string) => headers[name.toLowerCase()] },
    get: (key: 'authType' | 'apiKeyType') => vars[key],
  };
}

afterEach(() => setAnalyticsClientForTests(undefined));

describe('analytics.track', () => {
  test('captures distinctId, event, groups and properties; drops undefined', () => {
    const fake = fakeClient();
    setAnalyticsClientForTests(fake.client);
    track({
      event: 'prompt_sent',
      userId: 'user-1',
      accountId: 'acct-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      properties: { source: 'web', model: 'anthropic/claude', attachment_count: 2, skipped: undefined },
    });
    expect(fake.captured).toEqual([
      {
        distinctId: 'user-1',
        event: 'prompt_sent',
        properties: { source: 'web', model: 'anthropic/claude', attachment_count: 2, session_id: 'sess-1' },
        groups: { account: 'acct-1', project: 'proj-1' },
      },
    ]);
  });

  test('sends nothing without a user id', () => {
    const fake = fakeClient();
    setAnalyticsClientForTests(fake.client);
    track({ event: 'x', userId: null });
    expect(fake.captured).toEqual([]);
  });

  test('is a no-op without POSTHOG_KEY', () => {
    const prev = process.env.POSTHOG_KEY;
    delete process.env.POSTHOG_KEY;
    setAnalyticsClientForTests(undefined);
    expect(() => track({ event: 'x', userId: 'u' })).not.toThrow();
    if (prev !== undefined) process.env.POSTHOG_KEY = prev;
  });

  test('never throws when the client throws', () => {
    setAnalyticsClientForTests({
      capture: () => {
        throw new Error('boom');
      },
      groupIdentify: () => {
        throw new Error('boom');
      },
      shutdown: async () => {},
    });
    expect(() => track({ event: 'x', userId: 'u' })).not.toThrow();
    expect(() => identifyAccount('a', { tier: 'pro' })).not.toThrow();
  });
});

describe('analytics.identifyAccount / shutdown', () => {
  test('groupIdentify carries the account key and properties', () => {
    const fake = fakeClient();
    setAnalyticsClientForTests(fake.client);
    identifyAccount('acct-1', { tier: 'pro', seats: 3 });
    expect(fake.groups).toEqual([{ groupType: 'account', groupKey: 'acct-1', properties: { tier: 'pro', seats: 3 } }]);
  });

  test('shutdown flushes once and disables further capture', async () => {
    const fake = fakeClient();
    setAnalyticsClientForTests(fake.client);
    await shutdownAnalytics();
    track({ event: 'x', userId: 'u' });
    expect(fake.shutdowns).toBe(1);
    expect(fake.captured).toEqual([]);
  });
});

describe('analytics.requestSource', () => {
  test('X-Kortix-Client wins', () => {
    expect(requestSource(ctx({ 'x-kortix-client': 'cli', 'user-agent': 'Mozilla' }))).toBe('cli');
  });
  test('credential kind when no client header', () => {
    expect(requestSource(ctx({}, { authType: 'apiKey', apiKeyType: 'sandbox' }))).toBe('agent');
    expect(requestSource(ctx({}, { authType: 'pat' }))).toBe('api_key');
    expect(requestSource(ctx({}, { authType: 'service_account' }))).toBe('automation');
  });
  test('user agent fallback, default web', () => {
    expect(requestSource(ctx({ 'user-agent': 'kortix-cli/1.2' }))).toBe('cli');
    expect(requestSource(ctx({ 'user-agent': 'okhttp/4.9 Expo' }))).toBe('mobile');
    expect(requestSource(ctx({ 'user-agent': 'Mozilla/5.0' }))).toBe('web');
  });
  test('credential-looking client header is ignored', () => {
    expect(requestSource(ctx({ 'x-kortix-client': 'sk-abc', 'user-agent': 'Mozilla' }))).toBe('web');
  });
});

describe('analytics.providerForSecretName', () => {
  test('maps known LLM provider keys, null otherwise', () => {
    expect(providerForSecretName('ANTHROPIC_API_KEY')).toBe('anthropic');
    expect(providerForSecretName('AWS_BEDROCK_API_KEY')).toBe('bedrock');
    expect(providerForSecretName('DATABASE_URL')).toBeNull();
  });
});
