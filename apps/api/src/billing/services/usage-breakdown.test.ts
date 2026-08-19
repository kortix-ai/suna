import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { currentPeriodStart } from './usage-breakdown';

type LedgerRow = { type: string; kind: string; total: string };

let rows: LedgerRow[] = [];
let capturedProjection: unknown = null;
let capturedGroupBy: unknown[] = [];

mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: (projection: unknown) => {
      capturedProjection = projection;
      return {
        from: () => ({
          where: () => ({
            groupBy: async (...args: unknown[]) => {
              capturedGroupBy = args;
              return rows;
            },
          }),
        }),
      };
    },
  },
}));

const { classifyLedgerKind, getUsageBreakdownThisPeriod } = await import('./usage-breakdown');

function mentions(value: unknown, needle: string, seen = new WeakSet<object>()): boolean {
  if (typeof value === 'string') return value.includes(needle);
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value as Record<string, unknown>).some((v) => mentions(v, needle, seen));
}

beforeEach(() => {
  rows = [];
  capturedProjection = null;
  capturedGroupBy = [];
});

describe('classifyLedgerKind', () => {
  test('maps compute_debit to compute', () => {
    expect(classifyLedgerKind('compute_debit')).toBe('compute');
  });

  test('maps every LLM debit kind to llm', () => {
    expect(classifyLedgerKind('llm_debit')).toBe('llm');
    expect(classifyLedgerKind('token_deduction')).toBe('llm');
    expect(classifyLedgerKind('token_overage')).toBe('llm');
  });

  test('counts the flat RPC type as other rather than dropping it', () => {
    // CHANGED DELIBERATELY. This used to assert null, on the reasoning that
    // `usage` is the flat RPC type and therefore not a real category. True, but
    // the query filters on these lists, so returning null did not leave the
    // money uncategorised — it excluded the row from the result set entirely
    // and the spend vanished from the total. 10,859 such rows, $107.67, on the
    // production Kortix account. Money that left the wallet has to appear
    // somewhere; "other" is honest, silence is not.
    expect(classifyLedgerKind('usage')).toBe('other');
    expect(classifyLedgerKind('admin_debit')).toBe('other');
  });

  test('still refuses a refund or nothing', () => {
    // A refund is a CREDIT. Counting it as spend would overstate the bill, and
    // the sign guard in the query is the second line of defence.
    expect(classifyLedgerKind('tool_reservation_refund')).toBeNull();
    expect(classifyLedgerKind(null)).toBeNull();
  });
});

describe('getUsageBreakdownThisPeriod', () => {
  test('counts an RPC-written compute debit stored as type=usage with metadata.ledger_type=compute_debit', async () => {
    rows = [{ type: 'usage', kind: 'compute_debit', total: '0.2' }];

    const breakdown = await getUsageBreakdownThisPeriod('acct-1', '2026-07-01T00:00:00.000Z');

    expect(breakdown.compute_usd).toBeCloseTo(0.2, 10);
    expect(breakdown.llm_usd).toBe(0);
    expect(breakdown.total_usd).toBeCloseTo(0.2, 10);
  });

  test('counts an RPC-written LLM debit stored as type=usage with metadata.ledger_type=llm_debit', async () => {
    rows = [{ type: 'usage', kind: 'llm_debit', total: '1.5' }];

    const breakdown = await getUsageBreakdownThisPeriod('acct-1', '2026-07-01T00:00:00.000Z');

    expect(breakdown.llm_usd).toBeCloseTo(1.5, 10);
    expect(breakdown.compute_usd).toBe(0);
    expect(breakdown.total_usd).toBeCloseTo(1.5, 10);
  });

  test('splits a mixed period across compute and LLM', async () => {
    rows = [
      { type: 'usage', kind: 'compute_debit', total: '2.25' },
      { type: 'usage', kind: 'llm_debit', total: '0.75' },
      { type: 'usage', kind: 'token_overage', total: '0.25' },
    ];

    const breakdown = await getUsageBreakdownThisPeriod('acct-1', '2026-07-01T00:00:00.000Z');

    expect(breakdown.compute_usd).toBeCloseTo(2.25, 10);
    expect(breakdown.llm_usd).toBeCloseTo(1, 10);
    expect(breakdown.total_usd).toBeCloseTo(3.25, 10);
  });

  test('still classifies a legacy row whose granular kind lives on type with no metadata', async () => {
    rows = [{ type: 'compute_debit', kind: 'compute_debit', total: '4' }];

    const breakdown = await getUsageBreakdownThisPeriod('acct-1', '2026-07-01T00:00:00.000Z');

    expect(breakdown.compute_usd).toBe(4);
    expect(breakdown.total_usd).toBe(4);
  });

  test('ignores a kind that is neither compute nor LLM', async () => {
    rows = [{ type: 'tool_reservation_refund', kind: 'tool_reservation_refund', total: '9' }];

    const breakdown = await getUsageBreakdownThisPeriod('acct-1', '2026-07-01T00:00:00.000Z');

    expect(breakdown).toMatchObject({ compute_usd: 0, llm_usd: 0, total_usd: 0 });
  });

  test('asks the database for metadata ledger_type rather than credit_ledger.type alone', async () => {
    await getUsageBreakdownThisPeriod('acct-1', '2026-07-01T00:00:00.000Z');

    expect(mentions(capturedProjection, "->> 'ledger_type'")).toBe(true);
    expect(mentions(capturedGroupBy, "->> 'ledger_type'")).toBe(true);
  });

  test('reports the requested period start and leaves the period open', async () => {
    const breakdown = await getUsageBreakdownThisPeriod('acct-1', '2026-07-01T00:00:00.000Z');

    expect(breakdown.period_start).toBe('2026-07-01T00:00:00.000Z');
    expect(breakdown.period_end).toBeNull();
  });

  test('falls back to a 30-day window when the account has no billing cycle anchor', async () => {
    const before = Date.now();
    const breakdown = await getUsageBreakdownThisPeriod('acct-1', null);
    const after = Date.now();

    const start = new Date(breakdown.period_start as string).getTime();
    expect(start).toBeGreaterThanOrEqual(before - 30 * 86400 * 1000);
    expect(start).toBeLessThanOrEqual(after - 30 * 86400 * 1000);
  });
});

/**
 * "Spend this period" was anchored on Stripe's FIXED subscription anchor, which
 * never moves — so the window never reset and the figure quietly accumulated
 * LIFETIME spend under a this-period label. Production Kortix account: anchor
 * 2026-06-07, still being used two months later.
 */
describe('currentPeriodStart', () => {
  const now = new Date('2026-08-05T12:00:00.000Z');

  test('rolls a stale anchor forward to the current period', () => {
    // The exact production case: anchor 2026-06-07, read on 2026-08-05. The
    // period running on that date began 2026-07-07 — the 8th of August has not
    // happened yet. Before this, the window start was reported as the June
    // anchor, so "this period" covered two months and counting.
    expect(currentPeriodStart('2026-06-07T03:20:08.000Z', now)).toBe('2026-07-07T03:20:08.000Z');
  });

  test('never returns a start in the future', () => {
    const start = new Date(currentPeriodStart('2026-06-07T03:20:08.000Z', now)!);
    expect(start.getTime()).toBeLessThanOrEqual(now.getTime());
  });

  test('the period is at most one month long', () => {
    const start = new Date(currentPeriodStart('2026-06-07T03:20:08.000Z', now)!);
    const days = (now.getTime() - start.getTime()) / 86_400_000;
    expect(days).toBeLessThan(32);
  });

  test('mid-February, a 31st anchor is still in its January period', () => {
    // The period beginning Jan 31 runs until the February occurrence, so on
    // Feb 15 the answer is still January. My first version of this test
    // asserted Feb 28 and was simply wrong — Feb 28 is in the future here.
    expect(currentPeriodStart('2026-01-31T00:00:00.000Z', new Date('2026-02-15T00:00:00.000Z'))).toBe(
      '2026-01-31T00:00:00.000Z',
    );
  });

  test('clamps a 31st anchor to the last day of a shorter month', () => {
    // Stripe's own rule, and the case that actually exercises the clamp:
    // without it, Date rolls Feb 31 over into March 3.
    expect(currentPeriodStart('2026-01-31T00:00:00.000Z', new Date('2026-03-01T00:00:00.000Z'))).toBe(
      '2026-02-28T00:00:00.000Z',
    );
  });

  test('an anchor in the future is left alone', () => {
    expect(currentPeriodStart('2027-01-01T00:00:00.000Z', now)).toBe('2027-01-01T00:00:00.000Z');
  });

  test('a null or unparseable anchor yields null, never a wrong window', () => {
    expect(currentPeriodStart(null, now)).toBeNull();
    expect(currentPeriodStart('not-a-date', now)).toBeNull();
  });
});

/**
 * `usage` is what the router writes for a Kortix tool call. It was in neither
 * kind list, and the query filters on those lists — so the money was not merely
 * uncategorised, it was excluded from the result set and vanished from the
 * total. 10,859 such rows on the production Kortix account.
 */
describe('classifyLedgerKind covers every kind that is actually written', () => {
  test.each([
    ['compute_debit', 'compute'],
    ['llm_debit', 'llm'],
    ['token_deduction', 'llm'],
    ['token_overage', 'llm'],
    ['usage', 'other'],
    ['admin_debit', 'other'],
  ])('%s -> %s', (kind, expected) => {
    expect(classifyLedgerKind(kind)).toBe(expected as 'compute' | 'llm' | 'other');
  });

  test('no debit kind written anywhere in the API falls through to null', () => {
    // Grepped from apps/api/src: these are every ledger kind a debit is written
    // with. A kind missing here is money missing from the report.
    const written = ['compute_debit', 'llm_debit', 'token_deduction', 'token_overage', 'usage', 'admin_debit'];
    expect(written.filter((k) => classifyLedgerKind(k) === null)).toEqual([]);
  });
});
