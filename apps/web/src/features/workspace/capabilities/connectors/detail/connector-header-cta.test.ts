import { describe, expect, test } from 'bun:test';

import { connectorHeaderCta } from './connector-header-cta';

const base = {
  provider: 'composio' as const,
  canWrite: true,
  hasAuth: true,
  connected: false,
  accountCount: 0,
  hasComputer: false,
};

describe('connectorHeaderCta', () => {
  test('no account yet: connect', () => {
    expect(connectorHeaderCta(base)).toBe('connect');
  });
  test('accounts exist and none works: finish', () => {
    expect(connectorHeaderCta({ ...base, accountCount: 2 })).toBe('finish');
  });
  test('connected with exactly one account: replace', () => {
    expect(connectorHeaderCta({ ...base, connected: true, accountCount: 1 })).toBe('replace');
  });
  test('connected with several accounts: the rows own it', () => {
    expect(connectorHeaderCta({ ...base, connected: true, accountCount: 2 })).toBeNull();
  });
  test('a reader, a channel, and a no-auth connector show nothing', () => {
    expect(connectorHeaderCta({ ...base, canWrite: false })).toBeNull();
    expect(connectorHeaderCta({ ...base, provider: 'channel' })).toBeNull();
    expect(connectorHeaderCta({ ...base, hasAuth: false })).toBeNull();
  });
  test('a computer needs no write access and shows until one is paired', () => {
    expect(connectorHeaderCta({ ...base, provider: 'computer', canWrite: false })).toBe('connect');
    expect(
      connectorHeaderCta({ ...base, provider: 'computer', canWrite: false, hasComputer: true }),
    ).toBeNull();
  });
});
