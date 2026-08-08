/**
 * Admin activity analytics — "how active are our users?".
 *
 * Two read-only aggregates that answer the operator questions the accounts
 * console cannot: are people starting sessions every day, how many distinct
 * users and accounts are active, is that number growing, and what does it cost.
 *
 * AUTH: this router carries NO middleware of its own. It is mounted inside
 * `adminApp` (admin/index.ts) AFTER `adminApp.use('*', supabaseAuth,
 * requireAdmin)`, so every route below inherits the platform-admin gate —
 * ANON → 401, authed non-admin → 403. Hono applies `use('*')` by path prefix, and
 * a sub-app mounted with `.route()` sits under that prefix, so the gate runs
 * first. Flows ADM-20 / ADM-21 assert exactly that, and
 * `analytics-mount.test.ts` pins it at the unit level so a future refactor that
 * moves the mount above the gate fails a test instead of silently publishing
 * platform-wide activity data.
 *
 * WINDOWS: `?days=` (1..90, default 30) sizes the daily series. The summary
 * block uses its own fixed windows (1 / 7 / 30 days) so the tiles mean the same
 * thing regardless of the chart range the operator picked.
 *
 * TIMEZONE: every bucket is a UTC calendar day. See analytics-series.ts.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { accounts, creditLedger, projectSessions, projects } from '@kortix/db';
import { and, gte, lt, sql } from 'drizzle-orm';

import { classifyLedgerKind } from '../billing/services/usage-breakdown';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import { db } from '../shared/db';
import type { AppEnv } from '../types';
import {
  DEFAULT_ANALYTICS_DAYS,
  MAX_ANALYTICS_DAYS,
  MIN_ANALYTICS_DAYS,
  buildActivityDays,
  buildUsageDays,
  dayKeys,
  parseDays,
  trailingSum,
  windowStart,
  type LedgerDayRow,
  type SpendCategory,
} from './analytics-series';

export const analyticsApp = makeOpenApiApp<AppEnv>();

const MS_PER_DAY = 86_400_000;

/** Shared `?days=` query schema — documents the contract in the OpenAPI spec. */
const daysQuery = z.object({
  days: z
    .string()
    .optional()
    .openapi({
      param: { name: 'days', in: 'query' },
      description: `Size of the daily series, ${MIN_ANALYTICS_DAYS}-${MAX_ANALYTICS_DAYS} days. Out-of-range values are clamped; non-numeric falls back to ${DEFAULT_ANALYTICS_DAYS}.`,
      example: '30',
    }),
});

/**
 * `YYYY-MM-DD` UTC day bucket for a timestamptz column.
 *
 * `AT TIME ZONE 'UTC'` is what makes this deterministic: without it, date_trunc
 * would bucket by the database session's TimeZone GUC, so the same query would
 * return different daily counts against a server configured for a non-UTC zone.
 */
function utcDayBucket(column: unknown) {
  return sql<string>`to_char(date_trunc('day', ${column} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;
}

/**
 * The resolved spend kind of a ledger row.
 *
 * Debits are written by the atomic_use_credits RPC as `type = 'usage'` with the
 * granular kind in `metadata->>'ledger_type'`, so reading `type` alone reports
 * $0 compute and $0 LLM. Same expression as
 * billing/services/usage-breakdown.ts — kept identical on purpose so the admin
 * dashboard and a customer's own billing page can never disagree.
 */
const LEDGER_KIND = sql<string>`COALESCE(NULLIF(${creditLedger.metadata} ->> 'ledger_type', ''), ${creditLedger.type})`;

// ── Response schemas ─────────────────────────────────────────────────────────

const ActivityDaySchema = z
  .object({
    date: z.string().openapi({ example: '2026-08-07' }),
    sessionsCreated: z.number().int(),
    activeAccounts: z.number().int(),
    activeUsers: z.number().int(),
    newAccounts: z.number().int(),
    activeProjects: z.number().int(),
  })
  .openapi('AdminAnalyticsActivityDay');

const ActivityResponseSchema = z
  .object({
    days: z.array(ActivityDaySchema),
    summary: z.object({
      sessionsLast7d: z.number().int(),
      sessionsPrev7d: z.number().int(),
      dau: z.number().int(),
      wau: z.number().int(),
      mau: z.number().int(),
      totalAccounts: z.number().int(),
      totalProjects: z.number().int(),
    }),
  })
  .openapi('AdminAnalyticsActivity');

const UsageDaySchema = z
  .object({
    date: z.string().openapi({ example: '2026-08-07' }),
    computeUsd: z.number(),
    llmUsd: z.number(),
    otherUsd: z.number(),
    totalUsd: z.number(),
    payingAccounts: z.number().int(),
  })
  .openapi('AdminAnalyticsUsageDay');

const UsageResponseSchema = z
  .object({
    days: z.array(UsageDaySchema),
    summary: z.object({
      totalUsd: z.number(),
      computeUsd: z.number(),
      llmUsd: z.number(),
      otherUsd: z.number(),
      spendLast7d: z.number(),
      spendPrev7d: z.number(),
      payingAccountsLast7d: z.number().int(),
    }),
  })
  .openapi('AdminAnalyticsUsage');

// ── GET /v1/admin/analytics/activity ─────────────────────────────────────────

analyticsApp.openapi(
  createRoute({
    method: 'get',
    path: '/activity',
    tags: ['admin'],
    summary: 'Daily platform activity (admin console)',
    description:
      'Sessions created, active accounts, active users, new accounts and active projects per UTC day, plus DAU/WAU/MAU. "Active user" is a distinct `project_sessions.created_by`.',
    ...auth,
    request: { query: daysQuery },
    responses: {
      200: json(ActivityResponseSchema, 'Daily activity series + summary'),
      500: json(z.record(z.string(), z.any()), 'Server error'),
      ...errors(401, 403),
    },
  }),
  async (c) => {
    try {
      const days = parseDays(c.req.query('days'));
      const now = new Date();
      const keys = dayKeys(days, now);
      const since = windowStart(days, now);

      // Fixed summary windows, independent of `days`. Anchored on `now` (not on
      // a day boundary) so DAU means "the last 24 hours", which is what an
      // operator refreshing at 09:00 expects — a midnight-anchored DAU reads
      // near-zero every morning and looks like an outage.
      //
      // ISO strings, not Date objects. A `Date` interpolated into a RAW `sql`
      // fragment reaches postgres.js as an untyped parameter and it throws
      // `The "string" argument must be of type string ... Received an instance
      // of Date` — drizzle only applies its Date->string column mapper for
      // operators like `gte(column, value)`, never for a raw fragment. Hence
      // the explicit `::timestamptz` cast on each one below.
      const d1 = new Date(now.getTime() - 1 * MS_PER_DAY).toISOString();
      const d7 = new Date(now.getTime() - 7 * MS_PER_DAY).toISOString();
      const d14 = new Date(now.getTime() - 14 * MS_PER_DAY).toISOString();
      const d30 = new Date(now.getTime() - 30 * MS_PER_DAY);
      // The summary needs the widest of the two windows; scanning once for both
      // beats two range scans over overlapping data.
      const summarySince = since < d30 ? since : d30;

      const sessionDayBucket = utcDayBucket(projectSessions.createdAt);
      const accountDayBucket = utcDayBucket(accounts.createdAt);

      const [sessionRows, accountRows, [summaryRow], [totalsRow]] = await Promise.all([
        // Daily session activity. One bounded range scan on created_at.
        db
          .select({
            date: sessionDayBucket,
            sessionsCreated: sql<number>`count(*)::int`,
            activeAccounts: sql<number>`count(distinct ${projectSessions.accountId})::int`,
            activeUsers: sql<number>`count(distinct ${projectSessions.createdBy})::int`,
            activeProjects: sql<number>`count(distinct ${projectSessions.projectId})::int`,
          })
          .from(projectSessions)
          .where(gte(projectSessions.createdAt, since))
          .groupBy(sessionDayBucket),

        // Daily signups.
        db
          .select({
            date: accountDayBucket,
            newAccounts: sql<number>`count(*)::int`,
          })
          .from(accounts)
          .where(gte(accounts.createdAt, since))
          .groupBy(accountDayBucket),

        // Summary windows in a single pass with FILTER clauses.
        db
          .select({
            sessionsLast7d: sql<number>`count(*) filter (where ${projectSessions.createdAt} >= ${d7}::timestamptz)::int`,
            sessionsPrev7d: sql<number>`count(*) filter (where ${projectSessions.createdAt} >= ${d14}::timestamptz and ${projectSessions.createdAt} < ${d7}::timestamptz)::int`,
            dau: sql<number>`count(distinct ${projectSessions.createdBy}) filter (where ${projectSessions.createdAt} >= ${d1}::timestamptz)::int`,
            wau: sql<number>`count(distinct ${projectSessions.createdBy}) filter (where ${projectSessions.createdAt} >= ${d7}::timestamptz)::int`,
            mau: sql<number>`count(distinct ${projectSessions.createdBy}) filter (where ${projectSessions.createdAt} >= ${d30.toISOString()}::timestamptz)::int`,
          })
          .from(projectSessions)
          .where(gte(projectSessions.createdAt, summarySince)),

        // Platform totals. Two index-only counts, no time predicate.
        db
          .select({
            totalAccounts: sql<number>`(select count(*) from ${accounts})::int`,
            totalProjects: sql<number>`(select count(*) from ${projects})::int`,
          })
          .from(sql`(select 1) as one`),
      ]);

      return c.json(
        {
          days: buildActivityDays(keys, sessionRows, accountRows),
          summary: {
            sessionsLast7d: Number(summaryRow?.sessionsLast7d ?? 0),
            sessionsPrev7d: Number(summaryRow?.sessionsPrev7d ?? 0),
            dau: Number(summaryRow?.dau ?? 0),
            wau: Number(summaryRow?.wau ?? 0),
            mau: Number(summaryRow?.mau ?? 0),
            totalAccounts: Number(totalsRow?.totalAccounts ?? 0),
            totalProjects: Number(totalsRow?.totalProjects ?? 0),
          },
        },
        200,
      );
    } catch (error) {
      console.error('[admin/analytics/activity] failed', error);
      return c.json(
        { error: true, message: (error as Error).message, status: 500 } as Record<string, unknown>,
        500,
      );
    }
  },
);

// ── GET /v1/admin/analytics/usage ────────────────────────────────────────────

analyticsApp.openapi(
  createRoute({
    method: 'get',
    path: '/usage',
    tags: ['admin'],
    summary: 'Daily credit burn (admin console)',
    description:
      'Credit debits per UTC day split into compute / LLM / other, plus the number of distinct accounts that spent that day. Amounts are positive USD magnitudes.',
    ...auth,
    request: { query: daysQuery },
    responses: {
      200: json(UsageResponseSchema, 'Daily credit-burn series + summary'),
      500: json(z.record(z.string(), z.any()), 'Server error'),
      ...errors(401, 403),
    },
  }),
  async (c) => {
    try {
      const days = parseDays(c.req.query('days'));
      const now = new Date();
      const keys = dayKeys(days, now);
      // creditLedger.createdAt is a `mode: 'string'` column — compare with ISO
      // text, not a Date, or drizzle emits a parameter Postgres cannot coerce.
      const sinceIso = windowStart(days, now).toISOString();
      const ledgerDayBucket = utcDayBucket(creditLedger.createdAt);

      // Debits only. Grants, refunds and purchases are positive and would
      // cancel out real burn if summed together.
      const debitWindow = and(gte(creditLedger.createdAt, sinceIso), lt(creditLedger.amount, '0'));

      const [kindRows, payingRows] = await Promise.all([
        db
          .select({
            date: ledgerDayBucket,
            kind: LEDGER_KIND,
            usd: sql<number>`SUM(ABS(${creditLedger.amount}))::float8`,
          })
          .from(creditLedger)
          .where(debitWindow)
          .groupBy(ledgerDayBucket, LEDGER_KIND),

        db
          .select({
            date: ledgerDayBucket,
            payingAccounts: sql<number>`count(distinct ${creditLedger.accountId})::int`,
          })
          .from(creditLedger)
          .where(debitWindow)
          .groupBy(ledgerDayBucket),
      ]);

      // Map each raw ledger kind onto compute / llm / other with the SAME
      // classifier billing uses. An unrecognised kind classifies as null and is
      // dropped rather than silently folded into "other" — see
      // classifyLedgerKind for the kinds that count.
      const ledgerRows: LedgerDayRow[] = [];
      for (const row of kindRows) {
        const category = classifyLedgerKind(row.kind);
        if (!category) continue;
        ledgerRows.push({
          date: row.date,
          category: category as SpendCategory,
          usd: Number(row.usd) || 0,
        });
      }

      const series = buildUsageDays(keys, ledgerRows, payingRows);
      const payingAccountsLast7d = await countPayingAccounts(now, 7);

      return c.json(
        {
          days: series,
          summary: {
            totalUsd: series.reduce((sum, d) => sum + d.totalUsd, 0),
            computeUsd: series.reduce((sum, d) => sum + d.computeUsd, 0),
            llmUsd: series.reduce((sum, d) => sum + d.llmUsd, 0),
            otherUsd: series.reduce((sum, d) => sum + d.otherUsd, 0),
            spendLast7d: trailingSum(series, (d) => d.totalUsd, 7),
            spendPrev7d: trailingSum(series, (d) => d.totalUsd, 7, 7),
            payingAccountsLast7d,
          },
        },
        200,
      );
    } catch (error) {
      console.error('[admin/analytics/usage] failed', error);
      return c.json(
        { error: true, message: (error as Error).message, status: 500 } as Record<string, unknown>,
        500,
      );
    }
  },
);

/**
 * Distinct accounts with at least one debit in the trailing `days` days.
 *
 * Deliberately NOT summed from the daily series: an account that spends on
 * three separate days appears in three daily buckets, so adding
 * `payingAccounts` across days double-counts it. This is a separate
 * COUNT(DISTINCT) over the whole window.
 */
async function countPayingAccounts(now: Date, days: number): Promise<number> {
  const sinceIso = new Date(now.getTime() - days * MS_PER_DAY).toISOString();
  const [row] = await db
    .select({ payingAccounts: sql<number>`count(distinct ${creditLedger.accountId})::int` })
    .from(creditLedger)
    .where(and(gte(creditLedger.createdAt, sinceIso), lt(creditLedger.amount, '0')));
  return Number(row?.payingAccounts ?? 0);
}
