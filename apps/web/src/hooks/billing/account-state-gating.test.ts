import { describe, expect, test } from 'bun:test';

import { shouldQueryAccountState } from './account-state-gating';

describe('shouldQueryAccountState', () => {
  test('runs immediately outside any provider (global surfaces = primary account)', () => {
    expect(
      shouldQueryAccountState({
        enabled: true,
        hasExplicitAccountId: false,
        contextResolved: true,
      }),
    ).toBe(true);
  });

  test('waits while the surface has not resolved which account it bills', () => {
    expect(
      shouldQueryAccountState({
        enabled: true,
        hasExplicitAccountId: false,
        contextResolved: false,
      }),
    ).toBe(false);
  });

  test('an explicit accountId is answerable regardless of the provider', () => {
    expect(
      shouldQueryAccountState({
        enabled: true,
        hasExplicitAccountId: true,
        contextResolved: false,
      }),
    ).toBe(true);
  });

  test("the caller's own enabled:false still wins", () => {
    expect(
      shouldQueryAccountState({
        enabled: false,
        hasExplicitAccountId: true,
        contextResolved: true,
      }),
    ).toBe(false);
  });

  test('the workspace-shell boot sequence never fetches twice', () => {
    // Cold load: the shell mounts with no project-detail, so the sidebar's
    // billing items must stay quiet rather than resolve against the primary
    // account and then re-resolve against the workspace's — the two paints that
    // made Upgrade Plan flicker in and out.
    const beforeDetail = shouldQueryAccountState({
      enabled: true,
      hasExplicitAccountId: false,
      contextResolved: false,
    });
    const afterDetail = shouldQueryAccountState({
      enabled: true,
      hasExplicitAccountId: false,
      contextResolved: true,
    });
    expect([beforeDetail, afterDetail]).toEqual([false, true]);
  });
});
