import { beforeEach, describe, expect, test } from 'bun:test';

import {
  claimSessionCacheOwnership,
  getSessionCacheOwnership,
  resetSessionCacheOwnership,
  resolveSessionCacheOwnerScope,
  sessionCacheOwnerScopesConflict,
} from './session-cache-ownership';

beforeEach(() => {
  resetSessionCacheOwnership();
});

describe('OpenCode session cache ownership', () => {
  test('uses the Kortix session scope across sandbox replacements', () => {
    expect(resolveSessionCacheOwnerScope('sandbox-a', 'project-a/session-a')).toBe(
      'kortix:project-a/session-a',
    );
    expect(resolveSessionCacheOwnerScope('sandbox-b', 'project-a/session-a')).toBe(
      'kortix:project-a/session-a',
    );
  });

  test('falls back to the sandbox scope for standalone consumers', () => {
    expect(resolveSessionCacheOwnerScope('sandbox-a')).toBe('runtime:sandbox-a');
    expect(resolveSessionCacheOwnerScope('none')).toBeNull();
  });

  test('reports a collision when another sandbox reuses the same OpenCode id', () => {
    expect(claimSessionCacheOwnership('ses_shared', 'sandbox-a')).toEqual({
      changed: true,
      previousOwnerScope: null,
    });
    expect(claimSessionCacheOwnership('ses_shared', 'sandbox-b')).toEqual({
      changed: true,
      previousOwnerScope: 'sandbox-a',
    });
    expect(getSessionCacheOwnership('ses_shared')).toBe('sandbox-b');
  });

  test('keeps a repeated claim for the same sandbox stable', () => {
    claimSessionCacheOwnership('ses_1', 'sandbox-a');
    expect(claimSessionCacheOwnership('ses_1', 'sandbox-a')).toEqual({
      changed: false,
      previousOwnerScope: 'sandbox-a',
    });
  });

  test('a fallback scope never conflicts with the Kortix scope for the same session', () => {
    const authoritative = resolveSessionCacheOwnerScope('sandbox-a', 'project-a/session-a');
    const fallback = resolveSessionCacheOwnerScope('sandbox-a');
    expect(sessionCacheOwnerScopesConflict(authoritative, fallback)).toBe(false);
    expect(sessionCacheOwnerScopesConflict(fallback, authoritative)).toBe(false);
  });

  test('two scopes of the same kind still conflict', () => {
    expect(sessionCacheOwnerScopesConflict('runtime:sandbox-a', 'runtime:sandbox-b')).toBe(true);
    expect(
      sessionCacheOwnerScopesConflict('kortix:project-a/session-a', 'kortix:project-a/session-b'),
    ).toBe(true);
  });

  test('an unknown or identical owner is never a conflict', () => {
    expect(sessionCacheOwnerScopesConflict(null, 'runtime:sandbox-a')).toBe(false);
    expect(sessionCacheOwnerScopesConflict('runtime:sandbox-a', null)).toBe(false);
    expect(sessionCacheOwnerScopesConflict('runtime:sandbox-a', 'runtime:sandbox-a')).toBe(false);
  });

  test('a fallback claim does not displace the authoritative owner', () => {
    claimSessionCacheOwnership('ses_shared', 'kortix:project-a/session-a');
    expect(claimSessionCacheOwnership('ses_shared', 'runtime:sandbox-a')).toEqual({
      changed: false,
      previousOwnerScope: 'kortix:project-a/session-a',
    });
    expect(getSessionCacheOwnership('ses_shared')).toBe('kortix:project-a/session-a');
  });

  test('an authoritative claim upgrades a fallback owner', () => {
    claimSessionCacheOwnership('ses_shared', 'runtime:sandbox-a');
    expect(claimSessionCacheOwnership('ses_shared', 'kortix:project-a/session-a')).toEqual({
      changed: true,
      previousOwnerScope: 'runtime:sandbox-a',
    });
    expect(getSessionCacheOwnership('ses_shared')).toBe('kortix:project-a/session-a');
  });
});
