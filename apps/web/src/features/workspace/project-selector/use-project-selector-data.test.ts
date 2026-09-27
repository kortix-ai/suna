import { describe, expect, test } from 'bun:test';

import { speculativeProjectListAccountId } from './use-project-selector-data';

describe('speculativeProjectListAccountId', () => {
  test('reads the remembered account list while the account list is in flight', () => {
    expect(
      speculativeProjectListAccountId({ userId: 'u1', cachedAccountId: 'a1', accountsLoaded: false }),
    ).toBe('a1');
  });

  test('stops once the account list is known — the real fan-out takes over', () => {
    expect(
      speculativeProjectListAccountId({ userId: 'u1', cachedAccountId: 'a1', accountsLoaded: true }),
    ).toBeNull();
  });

  test('never reads before identity is known', () => {
    expect(
      speculativeProjectListAccountId({ userId: null, cachedAccountId: 'a1', accountsLoaded: false }),
    ).toBeNull();
  });

  test('no remembered account, no speculative read', () => {
    expect(
      speculativeProjectListAccountId({ userId: 'u1', cachedAccountId: null, accountsLoaded: false }),
    ).toBeNull();
    expect(
      speculativeProjectListAccountId({ userId: 'u1', cachedAccountId: '', accountsLoaded: false }),
    ).toBeNull();
  });
});
