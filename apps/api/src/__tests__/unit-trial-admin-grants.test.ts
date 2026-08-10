import { describe, expect, mock, test } from 'bun:test';

// Trial-admin touches the DB (sweep queries) and the credits RPC. Stub both so
// the grant semantics are exercised without a database.
const grantCalls: Array<{
  accountId: string;
  amount: number;
  type: string;
  isExpiring: boolean | undefined;
  opts: { expiresAt?: string | null; idempotencyKey?: string | null } | undefined;
}> = [];
mock.module('../billing/services/credits', () => ({
  grantCredits: async (
    accountId: string,
    amount: number,
    type: string,
    _description: string,
    isExpiring?: boolean,
    _stripeEventId?: string,
    opts?: { expiresAt?: string | null; idempotencyKey?: string | null },
  ) => {
    grantCalls.push({ accountId, amount, type, isExpiring, opts });
    return { success: true };
  },
}));

let storedRow: Record<string, unknown> | null = null;
mock.module('../billing/repositories/credit-accounts', () => ({
  getCreditAccount: async () => storedRow,
  upsertCreditAccount: async (_id: string, patch: Record<string, unknown>) => {
    storedRow = { ...(storedRow ?? {}), ...patch };
  },
}));
mock.module('../billing/services/entitlements', () => ({
  invalidateCachedAccountTier: () => {},
}));
mock.module('../shared/account-limits', () => ({
  clearAccountLimitCache: () => {},
}));
mock.module('../shared/db', () => ({ db: {} }));
// tiers.ts (grantForSeats lives there) imports the validated env config; stub
// the two fields it can touch so the test runs without a booted environment.
mock.module('../config', () => ({
  config: { INTERNAL_KORTIX_ENV: 'dev', KORTIX_LLM_MARKUP: undefined },
}));

const { grantTrial, trialMonthlyRegrant, TRIAL_GRANT_LEDGER_TYPE } = await import(
  '../billing/services/trial-admin'
);

const DAY_MS = 24 * 60 * 60 * 1000;
const START = new Date('2026-08-10T00:00:00Z');
const iso = (daysFromStart: number) => new Date(START.getTime() + daysFromStart * DAY_MS).toISOString();

describe('grantTrial credit grant', () => {
  // The COSMIC bug: the issue-time grant landed as PERMANENT credits, so an
  // ended trial left real spendable money behind. Trial credits must be
  // expiring and stamped with the trial window's end.
  test('issue-time grant is expiring and expires at the trial end', async () => {
    grantCalls.length = 0;
    storedRow = null;
    await grantTrial({
      accountId: 'acct_1',
      tierKey: 'team',
      seats: 6,
      durationDays: 50,
      creditGrant: 150,
    });
    expect(grantCalls).toHaveLength(1);
    const call = grantCalls[0]!;
    expect(call.amount).toBe(150);
    expect(call.type).toBe(TRIAL_GRANT_LEDGER_TYPE);
    expect(call.isExpiring).toBe(true);
    expect(call.opts?.expiresAt).toBeTruthy();
    // expiresAt ≈ now + 50d (grantTrial uses wall clock; assert the day).
    const expires = new Date(call.opts!.expiresAt!).getTime();
    expect(Math.abs(expires - (Date.now() + 50 * DAY_MS))).toBeLessThan(60_000);
  });
});

describe('trialMonthlyRegrant', () => {
  const trial = (over: Partial<Parameters<typeof trialMonthlyRegrant>[0]> = {}) => ({
    accountId: 'acct_1',
    startedAt: iso(0),
    endsAt: iso(90),
    seats: 6,
    ...over,
  });

  test('inside month 1 → nothing due (covered by the issue-time grant)', () => {
    expect(trialMonthlyRegrant(trial(), new Date(iso(29)))).toBeNull();
  });

  test('day 30 → month-2 grant of $25/seat', () => {
    const plan = trialMonthlyRegrant(trial(), new Date(iso(30)));
    expect(plan).not.toBeNull();
    expect(plan!.monthIndex).toBe(1);
    expect(plan!.amount).toBe(150); // 25 × 6 seats
  });

  test('day 61 → month-3 grant, distinct idempotency key from month 2', () => {
    const m2 = trialMonthlyRegrant(trial(), new Date(iso(30)))!;
    const m3 = trialMonthlyRegrant(trial(), new Date(iso(61)))!;
    expect(m3.monthIndex).toBe(2);
    expect(m3.idempotencyKey).not.toBe(m2.idempotencyKey);
  });

  test('same month, different day → same idempotency key (idempotent per month)', () => {
    const a = trialMonthlyRegrant(trial(), new Date(iso(30)))!;
    const b = trialMonthlyRegrant(trial(), new Date(iso(45)))!;
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
  });

  test('after the trial window ends → nothing due', () => {
    expect(trialMonthlyRegrant(trial({ endsAt: iso(50) }), new Date(iso(60)))).toBeNull();
  });

  test('seats default to 1 when null', () => {
    const plan = trialMonthlyRegrant(trial({ seats: null }), new Date(iso(30)));
    expect(plan!.amount).toBe(25);
  });

  test('missing window fields → null, never throws', () => {
    expect(trialMonthlyRegrant(trial({ startedAt: null }), new Date(iso(30)))).toBeNull();
    expect(trialMonthlyRegrant(trial({ endsAt: null }), new Date(iso(30)))).toBeNull();
  });
});
