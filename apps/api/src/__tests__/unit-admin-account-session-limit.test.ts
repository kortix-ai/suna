import { describe, expect, test } from 'bun:test';
import {
  MAX_ACCOUNT_SESSION_LIMIT,
  parseAccountSessionLimit,
  setAccountSessionLimit,
} from '../admin/account-session-limit';

describe('admin account session limit', () => {
  test('accepts null and bounded positive integers', () => {
    expect(parseAccountSessionLimit(null)).toBeNull();
    expect(parseAccountSessionLimit(1)).toBe(1);
    expect(parseAccountSessionLimit(MAX_ACCOUNT_SESSION_LIMIT)).toBe(MAX_ACCOUNT_SESSION_LIMIT);
  });

  test('rejects non-integers and values outside the supported range', () => {
    for (const value of [undefined, '1', 0, -1, 1.5, MAX_ACCOUNT_SESSION_LIMIT + 1]) {
      expect(() => parseAccountSessionLimit(value)).toThrow(
        `max_concurrent_sessions must be null or an integer from 1 to ${MAX_ACCOUNT_SESSION_LIMIT}`,
      );
    }
  });

  test('persists the override, clears the cache, and records the audit event', async () => {
    const calls: string[] = [];
    const result = await setAccountSessionLimit(
      {
        accountId: 'account-1',
        actorUserId: 'admin-1',
        maxConcurrentSessions: 1,
        ip: '203.0.113.10',
        userAgent: 'ke2e',
      },
      {
        getCurrent: async () => {
          calls.push('get');
          return 25;
        },
        persist: async (accountId, value) => {
          calls.push(`persist:${accountId}:${value}`);
        },
        clearCache: () => {
          calls.push('clear');
        },
        recordAudit: async (event) => {
          calls.push(
            `audit:${event.action}:${event.before?.max_concurrent_sessions}:${event.after?.max_concurrent_sessions}`,
          );
        },
      },
    );

    expect(result).toEqual({ previous: 25, current: 1 });
    expect(calls).toEqual([
      'get',
      'persist:account-1:1',
      'clear',
      'audit:admin.account.session_limit.set:25:1',
    ]);
  });

  test('restores the tier-derived behavior with a null override', async () => {
    const persisted: Array<number | null> = [];
    const result = await setAccountSessionLimit(
      {
        accountId: 'account-1',
        actorUserId: 'admin-1',
        maxConcurrentSessions: null,
        ip: null,
        userAgent: null,
      },
      {
        getCurrent: async () => 1,
        persist: async (_accountId, value) => {
          persisted.push(value);
        },
        clearCache: () => undefined,
        recordAudit: async () => undefined,
      },
    );

    expect(result).toEqual({ previous: 1, current: null });
    expect(persisted).toEqual([null]);
  });
});
