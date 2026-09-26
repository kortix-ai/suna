/**
 * Regression test for KRTX-423 / Better Stack pattern 0e4ee10d…:
 * `GET /v1/admin/analytics/usage` returned HTTP 500 whose body was the raw
 * Postgres `Failed query: select … from "kortix"."credit_ledger" …` text. The
 * admin dashboard SDK turned that into an `ApiError` which reached Sentry and
 * paged on a statement_timeout (SQLSTATE 57014) — an EXPECTED capacity state
 * for a platform-wide ledger aggregate, not a defect.
 *
 * The fix returns a typed 503 (`code: 'analytics_unavailable'`) with a plain
 * sentence and logs the real error server-side. These tests fail on the old
 * behaviour, where the body carried `(error as Error).message` (the SQL) and
 * the status was 500.
 *
 * `db` is mocked (the harness pattern from shared/cost-rollups.test.ts): the
 * route is driven through the real `analyticsApp`, and every `select()` chain
 * either resolves to queued rows or rejects with the driver's 57014 error.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let shouldFail = false;
let results: unknown[][] = [];

/** A postgres.js `Failed query` wrapper around a 57014 statement_timeout. */
function statementTimeoutError(): Error {
  const error = new Error(
    'Failed query: select to_char(date_trunc(\'day\', "created_at" AT TIME ZONE \'UTC\'), \'YYYY-MM-DD\'), SUM(ABS("amount_precise"))::float8 from "kortix"."credit_ledger" where ("created_at" >= $1 and "amount_precise" < $2) group by 1, 2',
  );
  // postgres.js sets `code` from the server; 57014 = query_canceled.
  Object.assign(error, { code: '57014' });
  return error;
}

function createQueryBuilder(rows: unknown[]) {
  const builder: Record<string, unknown> = {};
  for (const method of ['where', 'groupBy', 'orderBy', 'limit']) {
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
    select: (_fields: Record<string, unknown>) => ({
      from: (_table: unknown) => createQueryBuilder(results.shift() ?? []),
    }),
  },
  hasDatabase: true,
}));

const { analyticsApp, ANALYTICS_UNAVAILABLE_CODE } = await import('./analytics');

beforeEach(() => {
  shouldFail = false;
  results = [];
});

describe('GET /admin/analytics/usage — ledger aggregate failure', () => {
  test('a statement_timeout returns a typed 503, never the raw SQL', async () => {
    shouldFail = true;
    const response = await analyticsApp.request('/usage?days=1', { method: 'GET' });
    expect(response.status).toBe(503);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe(true);
    expect(body.code).toBe(ANALYTICS_UNAVAILABLE_CODE);

    // The load-bearing assertion: the raw Postgres message and the SQL must
    // never reach the client again.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('Failed query');
    expect(serialized).not.toContain('credit_ledger');
    expect(serialized).not.toContain('amount_precise');
  });

  test('a successful aggregate still returns the 200 series shape', async () => {
    // `days=1` windows today's UTC day only, so the fixture must use today's key.
    const today = new Date().toISOString().slice(0, 10);
    results = [
      // kindRows — one debit day.
      [{ date: today, kind: 'compute_debit', usd: 1.5 }],
      // payingRows.
      [{ date: today, payingAccounts: 1 }],
      // countPayingAccounts(now, 7).
      [{ payingAccounts: 1 }],
    ];
    const response = await analyticsApp.request('/usage?days=1', { method: 'GET' });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      days: Array<{ date: string; computeUsd: number; totalUsd: number }>;
      summary: { totalUsd: number; payingAccountsLast7d: number };
    };
    expect(body.days).toHaveLength(1);
    expect(body.days[0]?.computeUsd).toBe(1.5);
    expect(body.summary.totalUsd).toBe(1.5);
    expect(body.summary.payingAccountsLast7d).toBe(1);
  });
});
