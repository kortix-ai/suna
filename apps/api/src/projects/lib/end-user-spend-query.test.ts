/**
 * The spend cap's DB leg. The policy is pure and tested next door
 * (end-user-spend-cap.test.ts); what is left is the query, and a cap whose
 * query is wrong is worse than no cap — it reads as enforced while charging
 * the wrong end-user or summing the wrong window.
 *
 * So this renders the actual predicate and the actual SELECT and asserts on
 * them, rather than trusting a mock that returns rows regardless.
 */
import { describe, expect, mock, test } from 'bun:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

let lastFields: Record<string, unknown> | null = null;
let lastWhere: unknown = null;
let queryCount = 0;
let sumResult = '0';

// Same reason as the config mock below: spread the real module so the other
// exports (hasDatabase, …) survive.
const actualDb = await import('../../shared/db');
mock.module('../../shared/db', () => ({
  ...actualDb,
  db: {
    select: (fields: Record<string, unknown>) => {
      lastFields = fields;
      return {
        from: () => ({
          where: (predicate: unknown) => {
            lastWhere = predicate;
            queryCount += 1;
            return { limit: async () => [{ total: sumResult }] };
          },
        }),
      };
    },
  },
}));

// Spread the REAL module: a wholesale replacement drops every other export
// (SANDBOX_VERSION and friends) and the file then fails to LOAD, which reads as
// "the suite is broken" rather than "the mock is incomplete".
const actualConfig = await import('../../config');
mock.module('../../config', () => ({
  ...actualConfig,
  config: {
    ...actualConfig.config,
    KORTIX_BACKEND_PER_END_USER_SPEND_LIMIT_USD: 10,
    KORTIX_BACKEND_PER_END_USER_SPEND_WINDOW_DAYS: 7,
  },
}));

const { sumEndUserSpendUsd, enforcePerEndUserSpendCap } = await import('./sessions');

const renderWhere = () => new PgDialect().sqlToQuery(lastWhere as SQL);

describe('sumEndUserSpendUsd', () => {
  test('scopes to account AND end-user AND the window — never one of the three', async () => {
    await sumEndUserSpendUsd('acct-1', 'user-1', new Date('2026-07-21T00:00:00.000Z'));
    const { sql, params } = renderWhere();
    expect(sql).toContain('account_id');
    expect(sql).toContain('origin_ref');
    expect(sql).toContain('created_at');
    // Without the account predicate, one wrapper's end-user handle would sum
    // another wrapper's spend — end-user handles are opaque and can collide.
    expect(params).toContain('acct-1');
    expect(params).toContain('user-1');
  });

  test('sums the PRECISE cost column, not the legacy rounded one', async () => {
    // cost_usd is numeric(12,6); cost_usd_precise is numeric(20,10). Summing the
    // rounded column accumulates error across thousands of rows — visible in
    // exactly the place a ceiling is compared.
    await sumEndUserSpendUsd('acct-1', 'user-1', new Date());
    const rendered = new PgDialect().sqlToQuery(lastFields?.total as SQL);
    expect(rendered.sql).toContain('cost_usd_precise');
    expect(rendered.sql).not.toContain('"cost_usd"');
  });

  test('a null sum (this end-user has never spent) reads as 0, not NaN', async () => {
    sumResult = '0';
    expect(await sumEndUserSpendUsd('acct-1', 'nobody', new Date())).toBe(0);
  });

  test('a non-numeric sum degrades to 0 rather than poisoning the comparison', async () => {
    // NaN >= limit is false, so a garbage total must not silently DISABLE the cap.
    sumResult = 'not-a-number';
    expect(await sumEndUserSpendUsd('acct-1', 'user-1', new Date())).toBe(0);
    sumResult = '0';
  });
});

describe('enforcePerEndUserSpendCap', () => {
  test('does NOT query at all for a session with no end-user', async () => {
    // The cheap cases must be decided before touching the database — this runs
    // on the session-create hot path for every deployment.
    const before = queryCount;
    expect(await enforcePerEndUserSpendCap('acct-1', null)).toBeNull();
    expect(queryCount).toBe(before);
  });

  test('allows an end-user under the ceiling', async () => {
    sumResult = '9.5';
    expect(await enforcePerEndUserSpendCap('acct-1', 'user-1')).toBeNull();
  });

  test('refuses an end-user over the ceiling with the distinct 429 code', async () => {
    sumResult = '10.25';
    const err = await enforcePerEndUserSpendCap('acct-1', 'user-1');
    expect(err?.status).toBe(429);
    expect((err?.body as { code?: string }).code).toBe('per_end_user_spend_limit');
    expect((err?.body as { window_days?: number }).window_days).toBe(7);
    sumResult = '0';
  });
});
