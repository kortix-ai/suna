// Boundary proof for the 2026-08-21 per-project session controls, at the seam
// where they live: checkConcurrentSessionCap with its DB counts and account
// limit mocked, the REAL rate-limit bucket underneath. Heavier dependencies of
// lib/sessions are stubbed so its top-level imports resolve, and `mock.module`
// is process-global, so this file must be run on its own (--isolate).
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let activeInAccount = 0;
let activeInProject = 0;

mock.module('../../shared/account-limits', () => ({
  resolveAccountSessionLimit: async () => ({ tier: 'enterprise', limit: 10_000, source: 'tier' }),
  resolveAccountTier: async () => 'enterprise',
  accountUsesLlmGateway: async () => false,
  maxProjectsForAccount: async () => 10_000,
}));
mock.module('../../shared/audit', () => ({
  recordAuditEvent: async () => {},
  inferAuditSource: () => 'test',
  runAuditedTransaction: async (_ctx: unknown, fn: () => unknown) => fn(),
  requestAuditContext: () => ({}),
}));

// The two count queries share one shape (select→from→where→limit → one row of
// {activeCount}); the account count always runs first, the project count only
// when a projectId is passed. The stub answers by call order per invocation.
let dbCalls = 0;
mock.module('../../shared/db', () => ({
  hasDatabase: () => true,
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            dbCalls += 1;
            return [{ activeCount: dbCalls % 2 === 1 ? activeInAccount : activeInProject }];
          },
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  },
}));

import { config } from '../../config';
import { resetRateLimiters } from '../../shared/rate-limit';
import { checkConcurrentSessionCap } from './sessions';

describe('per-project session controls at the create seam', () => {
  beforeEach(() => {
    resetRateLimiters();
    dbCalls = 0;
    activeInAccount = 0;
    activeInProject = 0;
    (config as any).KORTIX_PROJECT_ACTIVE_SESSION_LIMIT = 2;
    (config as any).KORTIX_PROJECT_SESSION_CREATES_PER_HOUR = 1;
  });

  test('at the active cap the create refuses with project_session_limit', async () => {
    activeInProject = 2;
    const result = await checkConcurrentSessionCap('acc', 'user', undefined, 0, 'proj-cap');
    expect(result.error?.status).toBe(429);
    expect((result.error?.body as any)?.code).toBe('project_session_limit');
  });

  test('ORDERING: cap refusals never burn the create budget', async () => {
    activeInProject = 2;
    for (let i = 0; i < 5; i++) {
      const refused = await checkConcurrentSessionCap('acc', 'user', undefined, 0, 'proj-order');
      expect((refused.error?.body as any)?.code).toBe('project_session_limit');
    }
    activeInProject = 0;
    const afterCleanup = await checkConcurrentSessionCap('acc', 'user', undefined, 0, 'proj-order');
    expect(afterCleanup.error).toBeUndefined();
  });

  test('under the cap, the hourly budget refuses with project_session_create_limit', async () => {
    const first = await checkConcurrentSessionCap('acc', 'user', undefined, 0, 'proj-budget');
    expect(first.error).toBeUndefined();
    const second = await checkConcurrentSessionCap('acc', 'user', undefined, 0, 'proj-budget');
    expect(second.error?.status).toBe(429);
    expect((second.error?.body as any)?.code).toBe('project_session_create_limit');
    expect((second.error?.body as any)?.retry_after_seconds).toBeGreaterThan(0);
  });

  test('speculative warm pre-creates (reserveSlots=1) never consume the budget', async () => {
    for (let i = 0; i < 5; i++) {
      const warm = await checkConcurrentSessionCap('acc', 'user', undefined, 1, 'proj-warm');
      expect(warm.error).toBeUndefined();
    }
    const real = await checkConcurrentSessionCap('acc', 'user', undefined, 0, 'proj-warm');
    expect(real.error).toBeUndefined();
  });

  test('a create with no projectId (legacy caller) still passes the account path untouched', async () => {
    const result = await checkConcurrentSessionCap('acc', 'user', undefined, 0);
    expect(result.error).toBeUndefined();
    expect(result.headers['X-RateLimit-Limit']).toBe('10000');
  });
});
