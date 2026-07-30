import { beforeEach, describe, expect, mock, test } from 'bun:test';

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

  test('refuses to classify the flat RPC type, a refund, or nothing', () => {
    expect(classifyLedgerKind('usage')).toBeNull();
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
