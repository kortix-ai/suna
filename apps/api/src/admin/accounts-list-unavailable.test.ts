/**
 * Regression test for a prod incident (2026-09-27): `GET /v1/admin/api/accounts`
 * (the admin console's `/admin/accounts` page) returned HTTP 500 whose body was
 * the raw Postgres `Failed query: select "kortix"."accounts"."account_id", … ,
 * "kortix"."credit_accounts"."balance_precise" …` text. API logs showed the
 * route at 25013/25019/25056 ms against the 25s request-path
 * `statement_timeout` (SQLSTATE 57014) — an EXPECTED capacity state (see
 * `idx_accounts_created_at`'s migration for the missing-index root cause), not
 * a defect, so it must never leak SQL to the browser.
 *
 * The fix returns a typed 503 (`code: 'accounts_list_unavailable'`) with a
 * plain sentence and logs the real error server-side. These tests fail on the
 * old behaviour, where the body carried `adminErrorMessage(e)` (which
 * deliberately includes the raw driver message and SQL for other admin errors)
 * and the status was 500.
 *
 * `db` is mocked (the harness pattern from `analytics-usage-unavailable.test.ts`
 * / `__tests__/e2e-ops-overview.test.ts`): the route is driven through the real
 * `adminApp` (with `supabaseAuth`/`requireAdmin` stubbed to pass through, same
 * as `e2e-ops-overview.test.ts`), and every `select()` chain either resolves to
 * queued rows or rejects with the driver's 57014 error.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let shouldFail = false;
let results: unknown[][] = [];

/** A postgres.js `Failed query` wrapper around a 57014 statement_timeout. */
function statementTimeoutError(): Error {
  const error = new Error(
    'Failed query: select "kortix"."accounts"."account_id", "kortix"."accounts"."name", ' +
      '"kortix"."credit_accounts"."balance_precise" from "kortix"."accounts" left join ' +
      '"kortix"."credit_accounts" on "kortix"."credit_accounts"."account_id" = ' +
      '"kortix"."accounts"."account_id" order by "kortix"."accounts"."created_at" desc limit $1',
  );
  // postgres.js sets `code` from the server; 57014 = query_canceled.
  Object.assign(error, { code: '57014' });
  return error;
}

function createQueryBuilder(rows: unknown[]) {
  const builder: Record<string, unknown> = {};
  for (const method of ['from', 'leftJoin', 'where', 'orderBy', 'limit', 'offset']) {
    builder[method] = () => builder;
  }
  // biome-ignore lint/suspicious/noThenProperty: Drizzle query mocks must be awaitable.
  builder.then = (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) => {
    if (shouldFail) reject(statementTimeoutError());
    else resolve(rows);
  };
  return builder;
}

mock.module('../shared/db', () => ({
  db: {
    select: (_fields: Record<string, unknown>) => createQueryBuilder(results.shift() ?? []),
  },
  hasDatabase: true,
}));

mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: any) => {
    c.set('userId', '00000000-0000-4000-a000-000000000001');
    await next();
  },
}));

mock.module('../middleware/require-admin', () => ({
  requireAdmin: async (_c: any, next: any) => {
    await next();
  },
}));

const { adminApp, ACCOUNTS_LIST_UNAVAILABLE_CODE } = await import('./index');

beforeEach(() => {
  shouldFail = false;
  results = [];
});

describe('GET /admin/api/accounts — list query failure', () => {
  test('a statement_timeout returns a typed 503, never the raw SQL', async () => {
    shouldFail = true;
    const response = await adminApp.request('/api/accounts', { method: 'GET' });
    expect(response.status).toBe(503);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe(true);
    expect(body.code).toBe(ACCOUNTS_LIST_UNAVAILABLE_CODE);

    // The load-bearing assertion: the raw Postgres message and the SQL must
    // never reach the client again.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('Failed query');
    expect(serialized).not.toContain('credit_accounts');
    expect(serialized).not.toContain('balance_precise');
  });

  test('a successful query still returns the 200 accounts-page shape', async () => {
    results = [
      // rows — one account, no credit_accounts row (left join miss).
      [
        {
          accountId: '00000000-0000-4000-a000-000000000002',
          name: 'Test Account',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          balance: null,
          expiringCredits: null,
          nonExpiringCredits: null,
          dailyCreditsBalance: null,
          tier: null,
          paymentStatus: null,
          provider: null,
          planType: null,
          stripeSubscriptionId: null,
          stripeSubscriptionStatus: null,
          billingModel: null,
          seatCount: null,
          trialStatus: null,
          trialTier: null,
          trialSeats: null,
          trialStartedAt: null,
          trialEndsAt: null,
          trialNote: null,
          managedModelsOverride: null,
          demoEnterprise: false,
          enterpriseEntitled: false,
          entitlementOverrides: {},
          ownerEmail: null,
          memberCount: 0,
        },
      ],
      // total count.
      [{ total: 1 }],
    ];
    const response = await adminApp.request('/api/accounts', { method: 'GET' });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      accounts: Array<{ accountId: string }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]?.accountId).toBe('00000000-0000-4000-a000-000000000002');
  });
});
