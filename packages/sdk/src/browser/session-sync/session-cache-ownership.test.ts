import { beforeEach, describe, expect, test } from 'bun:test';

import {
  claimSessionCacheOwnership,
  getSessionCacheOwnership,
  resolveSessionCacheOwnerScope,
  resetSessionCacheOwnership,
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
});
