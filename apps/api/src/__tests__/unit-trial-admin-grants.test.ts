import { describe, expect, mock, test } from 'bun:test';
import { createFakeWallet } from './helpers/fake-wallet';

// Trial-admin touches the DB (sweep queries) and the wallet. Stub both so the
// grant semantics are exercised without a database.
const fake = createFakeWallet();
const grantCalls = fake.calls.grant;
mock.module('../billing/wallet', () => ({ wallet: fake.wallet }));

let storedRow: Record<string, unknown> | null = null;
mock.module('../billing/repositories/credit-accounts', () => ({
  getCreditAccount: async () => storedRow,
  upsertCreditAccount: async (_id: string, patch: Record<string, unknown>) => {
    storedRow = { ...(storedRow ?? {}), ...patch };
  },
  // account-write-owner.ts imports this name; partial mocks break the chain.
  updateCreditAccount: async (_id: string, patch: Record<string, unknown>) => {
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
// tiers.ts imports the validated env config; stub
// the two fields it can touch so the test runs without a booted environment.
mock.module('../config', () => ({
  config: { INTERNAL_KORTIX_ENV: 'dev', KORTIX_LLM_MARKUP: undefined },
}));

const {
  DEFAULT_ENTERPRISE_TRIAL_CREDITS_USD,
  grantTrial,
  markTrialConverted,
  revokeTrial,
  TRIAL_GRANT_LEDGER_TYPE,
  validateGrantTrialInput,
  withoutTrialCopies,
} = await import('../billing/services/trial-admin');

const DAY_MS = 24 * 60 * 60 * 1000;

function reset() {
  grantCalls.length = 0;
  storedRow = null;
}

// A trial is a dated grant of a plan on the trial columns, with one expiring
// credit grant (.agents/skills/billing/references/plans-and-access.md, "Trials").

describe('grantTrial', () => {
  test('writes the trial columns and one credit grant that expires at the trial end', async () => {
    reset();
    const result = await grantTrial({ accountId: 'acct_1', tierKey: 'credits', durationDays: 50, creditGrant: 150 });
    expect(storedRow!.trialStatus).toBe('active');
    expect(storedRow!.trialTier).toBe('credits');
    expect(storedRow!.trialMonthlyUsd).toBeNull();
    expect(grantCalls).toHaveLength(1);
    const call = grantCalls[0]!;
    expect(call.amount).toBe(150);
    expect(call.kind).toBe(TRIAL_GRANT_LEDGER_TYPE);
    expect(call.expiring).toBe(true);
    expect(call.expiresAt).toBe(storedRow!.trialEndsAt as string);
    expect(Math.abs(new Date(call.expiresAt!).getTime() - (Date.now() + 50 * DAY_MS))).toBeLessThan(60_000);
    expect(result.creditGranted).toBe(150);
  });

  test('an Enterprise trial grants the default credits; a Credits trial grants none unless asked', async () => {
    reset();
    expect((await grantTrial({ accountId: 'acct_1', tierKey: 'enterprise', durationDays: 30 })).creditGranted).toBe(
      DEFAULT_ENTERPRISE_TRIAL_CREDITS_USD,
    );
    reset();
    expect((await grantTrial({ accountId: 'acct_1', tierKey: 'credits', durationDays: 30 })).creditGranted).toBe(0);
    expect(grantCalls).toHaveLength(0);
  });

  test('it writes no entitlement overrides: the trial plan decides', async () => {
    reset();
    await grantTrial({ accountId: 'acct_1', tierKey: 'enterprise', durationDays: 30, creditGrant: 0 });
    expect(storedRow!.entitlementOverrides).toEqual({});
  });

  test('re-granting the same plan extends: the start date stays, the end moves', async () => {
    reset();
    await grantTrial({ accountId: 'acct_1', tierKey: 'enterprise', durationDays: 10, creditGrant: 0 });
    const startedAt = storedRow!.trialStartedAt;
    const firstEnd = storedRow!.trialEndsAt as string;
    await grantTrial({ accountId: 'acct_1', tierKey: 'enterprise', durationDays: 40, creditGrant: 0 });
    expect(storedRow!.trialStartedAt).toBe(startedAt);
    expect(new Date(storedRow!.trialEndsAt as string).getTime()).toBeGreaterThan(new Date(firstEnd).getTime());
  });

  test('only credits and enterprise are trial plans; a retired key is refused', () => {
    expect(validateGrantTrialInput({ tierKey: 'free', durationDays: 30 })).toMatch(/'credits' or 'enterprise'/);
    expect(validateGrantTrialInput({ tierKey: 'team', durationDays: 30 })).toMatch(/'credits' or 'enterprise'/);
    expect(validateGrantTrialInput({ tierKey: 'enterprise', durationDays: 0 })).toMatch(/duration_days/);
    expect(validateGrantTrialInput({ tierKey: 'enterprise', durationDays: 30, creditGrant: -1 })).toMatch(/credit_grant/);
  });
});

describe('legacy override copies', () => {
  // Before the one-plan model a trial also wrote its plan's entitlements into
  // entitlement_overrides, each expiring at the trial end.
  const END = '2026-11-01T00:00:00.000Z';
  const copies = {
    sso: { value: true, expires_at: END },
    scim: { value: true, expires_at: END },
    managedModels: { value: true, expires_at: END },
    rbac: { value: true, expires_at: '2027-01-01T00:00:00.000Z' }, // an operator's own override
    branding: { value: false },
  };

  test('withoutTrialCopies drops exactly the entries that expire at the trial end', () => {
    expect(withoutTrialCopies(copies, END)).toEqual({
      rbac: { value: true, expires_at: '2027-01-01T00:00:00.000Z' },
      branding: { value: false },
    });
  });

  test('revokeTrial and markTrialConverted remove them', async () => {
    reset();
    storedRow = { trialStatus: 'active', trialTier: 'enterprise', trialEndsAt: END, entitlementOverrides: copies };
    expect((await revokeTrial('acct_1')).current.status).toBe('revoked');
    expect(storedRow!.entitlementOverrides).toEqual(withoutTrialCopies(copies, END));

    storedRow = { trialStatus: 'active', trialTier: 'enterprise', trialEndsAt: END, entitlementOverrides: copies };
    expect(await markTrialConverted('acct_1', 'enterprise')).toBe(true);
    expect(storedRow!.trialStatus).toBe('converted');
    expect(storedRow!.entitlementOverrides).toEqual(withoutTrialCopies(copies, END));
  });
});

describe('markTrialConverted', () => {
  test('buying Credits ends a Credits trial', async () => {
    reset();
    storedRow = { trialStatus: 'active', trialTier: 'credits', trialEndsAt: '2026-11-01T00:00:00.000Z' };
    expect(await markTrialConverted('acct_1', 'credits')).toBe(true);
  });

  test('buying Credits leaves an Enterprise trial running to its end', async () => {
    reset();
    storedRow = { trialStatus: 'active', trialTier: 'enterprise', trialEndsAt: '2026-11-01T00:00:00.000Z' };
    expect(await markTrialConverted('acct_1', 'credits')).toBe(false);
    expect(storedRow!.trialStatus).toBe('active');
  });

  test('a contract ends any trial', async () => {
    reset();
    storedRow = { trialStatus: 'active', trialTier: 'enterprise', trialEndsAt: '2026-11-01T00:00:00.000Z' };
    expect(await markTrialConverted('acct_1', 'enterprise')).toBe(true);
  });

  test('a trial that is not active is left alone', async () => {
    reset();
    storedRow = { trialStatus: 'expired', trialTier: 'credits' };
    expect(await markTrialConverted('acct_1')).toBe(false);
  });
});
