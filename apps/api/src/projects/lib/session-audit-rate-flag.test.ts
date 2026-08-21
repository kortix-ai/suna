/**
 * The durable marker for a sustained-hot session.
 *
 * The load-bearing property is that it CANNOT fail loudly: it is invoked
 * un-awaited from the audit ingest hot path, so a rejected promise here would
 * surface as an unhandled rejection rather than a handled error.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

let updateCalls: Array<{ set: Record<string, unknown> }> = [];
let updateShouldThrow = false;

mock.module('../../shared/db', () => ({
  hasDatabase: () => true,
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        if (updateShouldThrow) throw new Error('database is unavailable');
        updateCalls.push({ set: values });
        return { where: async () => undefined };
      },
    }),
  }, auditDb: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        if (updateShouldThrow) throw new Error('database is unavailable');
        updateCalls.push({ set: values });
        return { where: async () => undefined };
      },
    }),
  },
}));

const {
  AUDIT_RATE_LIMIT_METADATA_KEY,
  flagSessionAuditRateLimited,
  readAuditRateLimitFlag,
} = await import('./session-audit-rate-flag');

const INPUT = {
  accountId: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  sessionId: '33333333-3333-4333-8333-333333333333',
  consecutiveHotWindows: 3,
  now: new Date('2026-08-19T04:00:00.000Z'),
};

beforeEach(() => {
  updateCalls = [];
  updateShouldThrow = false;
});

afterEach(() => {
  updateShouldThrow = false;
});

describe('flagSessionAuditRateLimited', () => {
  test('writes the marker into session_sandboxes.metadata', async () => {
    await flagSessionAuditRateLimited(INPUT);

    expect(updateCalls).toHaveLength(1);
    // The metadata value is a jsonb merge expression, not a literal — the point
    // is that the write happened and left `updatedAt` alone.
    expect(Object.keys(updateCalls[0].set)).toEqual(['metadata']);
  });

  test('never rejects when the database write fails', async () => {
    updateShouldThrow = true;

    // No try/catch here on purpose: the assertion IS that this resolves.
    await expect(flagSessionAuditRateLimited(INPUT)).resolves.toBeUndefined();
    expect(updateCalls).toHaveLength(0);
  });
});

describe('readAuditRateLimitFlag', () => {
  test('reads back a well-formed marker', () => {
    const flag = readAuditRateLimitFlag({
      [AUDIT_RATE_LIMIT_METADATA_KEY]: {
        consecutiveHotWindows: 4,
        at: '2026-08-19T04:00:00.000Z',
      },
      somethingElse: true,
    });

    expect(flag).toEqual({ consecutiveHotWindows: 4, at: '2026-08-19T04:00:00.000Z' });
  });

  test('returns null when the marker is absent or malformed', () => {
    expect(readAuditRateLimitFlag(null)).toBeNull();
    expect(readAuditRateLimitFlag(undefined)).toBeNull();
    expect(readAuditRateLimitFlag({})).toBeNull();
    expect(readAuditRateLimitFlag({ [AUDIT_RATE_LIMIT_METADATA_KEY]: 'hot' })).toBeNull();
    expect(readAuditRateLimitFlag({ [AUDIT_RATE_LIMIT_METADATA_KEY]: [] })).toBeNull();
    expect(
      readAuditRateLimitFlag({ [AUDIT_RATE_LIMIT_METADATA_KEY]: { consecutiveHotWindows: 2 } }),
    ).toBeNull();
    expect(
      readAuditRateLimitFlag({
        [AUDIT_RATE_LIMIT_METADATA_KEY]: { consecutiveHotWindows: 'many', at: 'now' },
      }),
    ).toBeNull();
  });
});
