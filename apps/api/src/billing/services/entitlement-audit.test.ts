import { beforeEach, describe, expect, mock, test } from 'bun:test';

let accountRows: Record<string, unknown>[] = [];

mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => ({
      from: () => Promise.resolve(accountRows),
    }),
  }, auditDb: {
    select: () => ({
      from: () => Promise.resolve(accountRows),
    }),
  },
}));

const { auditEntitlement } = await import('./entitlement-audit');

function account(overrides: Record<string, unknown> = {}) {
  return {
    accountId: '00000000-0000-4000-8000-000000000001',
    tier: 'tier_2_20',
    billingModel: 'legacy',
    seatCount: null,
    expiringCredits: '20',
    ...overrides,
  };
}

beforeEach(() => {
  accountRows = [];
});

describe('auditEntitlement — reports, never mutates', () => {
  test('a fleet exactly at entitlement reports no breach', async () => {
    accountRows = [
      account(),
      account({
        accountId: '00000000-0000-4000-8000-000000000002',
        tier: 'free',
        expiringCredits: '2',
      }),
      account({
        accountId: '00000000-0000-4000-8000-000000000003',
        tier: 'per_seat',
        billingModel: 'per_seat',
        seatCount: 4,
        expiringCredits: '100',
      }),
    ];

    const report = await auditEntitlement();

    expect(report.accountsScanned).toBe(3);
    expect(report.overGrantedCount).toBe(0);
    expect(report.overGrantedTotalUsd).toBe(0);
  });

  test('spending below entitlement is never reported as drift', async () => {
    accountRows = [account({ expiringCredits: '0' }), account({ expiringCredits: '7.5' })];

    const report = await auditEntitlement();

    expect(report.overGrantedCount).toBe(0);
  });

  test('the 1.6x per-seat over-grant is surfaced with its dollar excess', async () => {
    accountRows = [
      account({
        tier: 'per_seat',
        billingModel: 'per_seat',
        seatCount: 4,
        expiringCredits: '160',
      }),
    ];

    const report = await auditEntitlement();

    expect(report.overGrantedCount).toBe(1);
    expect(report.overGrantedTotalUsd).toBe(60);
    expect(report.worstOffenders[0].expectedUsd).toBe(100);
    expect(report.worstOffenders[0].actualUsd).toBe(160);
  });

  test('offenders are ranked by excess, worst first', async () => {
    accountRows = [
      account({ accountId: '00000000-0000-4000-8000-00000000000a', expiringCredits: '30' }),
      account({ accountId: '00000000-0000-4000-8000-00000000000b', expiringCredits: '120' }),
      account({ accountId: '00000000-0000-4000-8000-00000000000c', expiringCredits: '25' }),
    ];

    const report = await auditEntitlement();

    expect(report.overGrantedCount).toBe(3);
    expect(report.worstOffenders.map((row) => row.excessUsd)).toEqual([100, 10, 5]);
  });

  test('negative expiring balances are counted and totalled separately', async () => {
    accountRows = [
      account({ expiringCredits: '-648.70' }),
      account({ accountId: '00000000-0000-4000-8000-00000000000d', expiringCredits: '-1.30' }),
      account({ accountId: '00000000-0000-4000-8000-00000000000e', expiringCredits: '20' }),
    ];

    const report = await auditEntitlement();

    expect(report.negativeExpiringCount).toBe(2);
    expect(report.negativeExpiringTotalUsd).toBeCloseTo(-650, 6);
    expect(report.overGrantedCount).toBe(0);
  });

  test('the worst-offender list is capped without losing the totals', async () => {
    accountRows = Array.from({ length: 40 }, (_, i) =>
      account({
        accountId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        expiringCredits: '30',
      }),
    );

    const report = await auditEntitlement(5);

    expect(report.overGrantedCount).toBe(40);
    expect(report.overGrantedTotalUsd).toBe(400);
    expect(report.worstOffenders).toHaveLength(5);
  });

  test('an empty fleet is clean, not a crash', async () => {
    const report = await auditEntitlement();

    expect(report.accountsScanned).toBe(0);
    expect(report.overGrantedCount).toBe(0);
    expect(report.worstOffenders).toEqual([]);
  });
});
