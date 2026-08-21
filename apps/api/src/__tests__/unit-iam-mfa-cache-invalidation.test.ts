/**
 * PATCH /{accountId}/iam/mfa-required must bust the IAM cache for the whole
 * account on every real flip. Without it, resolveActorV2's memo (keyed
 * `${userId}|${accountId}`) keeps serving the pre-flip accountMfaRequired for
 * up to IAM_CACHE_TTL_MS — an admin who just disabled the requirement stays
 * locked out, or a member who should now be locked out keeps access.
 *
 * ttlMemo bypasses caching entirely under `bun test` (see shared/ttl-memo.ts),
 * so the real cache can't be exercised end to end here — this instead proves
 * the route WIRES the bust in: it calls invalidateIamCacheForAccount with the
 * account whose flag just changed, and only when the value actually changed.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

let mfaRequired = true;
const invalidateCalls: string[] = [];

const realIam = await import('../iam');

mock.module('../iam', () => ({
  ...realIam,
  ACCOUNT_ACTIONS: { ACCOUNT_READ: 'account.read', ACCOUNT_WRITE: 'account.write' },
  assertAuthorized: async () => {},
}));

const realCacheInvalidation = await import('../iam/cache-invalidation');
const realInvalidateIamCacheForAccount = realCacheInvalidation.invalidateIamCacheForAccount;

mock.module('../iam/cache-invalidation', () => ({
  ...realCacheInvalidation,
  invalidateIamCacheForAccount: async (accountId: string) => {
    invalidateCalls.push(accountId);
    await realInvalidateIamCacheForAccount(accountId);
  },
}));

mock.module('../shared/audit', () => ({
  recordAuditEvent: async () => {},
}));

mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ mfaRequired }],
        }),
      }),
    }),
    update: () => ({
      set: (patch: { mfaRequired: boolean }) => ({
        where: async () => {
          mfaRequired = patch.mfaRequired;
        },
      }),
    }),
  },
}));

const { iamRouter } = await import('../accounts/iam/app');
await import('../accounts/iam/mfa');

function buildApp() {
  const app = new Hono();
  app.use('*', async (c: any, next: any) => {
    c.set('userId', 'admin-1');
    await next();
  });
  app.route('/', iamRouter);
  return app;
}

async function patchMfaRequired(enabled: boolean) {
  return buildApp().request('/acct-1/iam/mfa-required', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

describe('PATCH mfa-required — cache invalidation', () => {
  beforeEach(() => {
    mfaRequired = true;
    invalidateCalls.length = 0;
  });

  test('disabling an enabled requirement busts the account cache', async () => {
    const res = await patchMfaRequired(false);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
    expect(invalidateCalls).toEqual(['acct-1']);
  });

  test('a no-op flip (value unchanged) does not bust the cache', async () => {
    mfaRequired = false;
    const res = await patchMfaRequired(false);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, unchanged: true });
    expect(invalidateCalls).toEqual([]);
  });
});
