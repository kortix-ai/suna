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
mock.module('../shared/db', () => ({ db: {} , auditDb: {}}));
// tiers.ts (grantForSeats lives there) imports the validated env config; stub
// the two fields it can touch so the test runs without a booted environment.
mock.module('../config', () => ({
  config: { INTERNAL_KORTIX_ENV: 'dev', KORTIX_LLM_MARKUP: undefined },
}));

const {
  grantTemporaryAccess,
  grantTrial,
  temporaryAccessOverrides,
  trialMonthlyRegrant,
  TEMPORARY_ACCESS_OVERRIDE_KEYS,
  TRIAL_GRANT_LEDGER_TYPE,
} = await import('../billing/services/trial-admin');
const { PLAN_CATALOG } = await import('../billing/services/plan-catalog');
const { readOverride } = await import('../billing/services/entitlement-overrides');

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

// ─── grantTemporaryAccess — the primitive behind a trial ─────────────────────
// "Behave as plan X, with $Y of credits, until date Z", where every part
// expires by arithmetic instead of waiting for a sweep to notice.

describe('temporaryAccessOverrides (pure)', () => {
  const END = '2026-09-10T00:00:00.000Z';

  test('an enterprise plan expands into the four identity entitlements', () => {
    const o = temporaryAccessOverrides(PLAN_CATALOG.enterprise!, END);
    expect(o.sso).toEqual({ value: true, expires_at: END });
    expect(o.scim).toEqual({ value: true, expires_at: END });
    expect(o.rbac).toEqual({ value: true, expires_at: END });
    expect(o.auditAccess).toEqual({ value: true, expires_at: END });
    expect(o.managedModels).toEqual({ value: true, expires_at: END });
    expect(o.maxConcurrentSessions).toEqual({ value: 5000, expires_at: END });
  });

  test('a non-enterprise plan grants none of them — a Team pilot is not SSO', () => {
    const o = temporaryAccessOverrides(PLAN_CATALOG.per_seat!, END);
    expect(o.sso).toBeUndefined();
    expect(o.scim).toBeUndefined();
    expect(o.rbac).toBeUndefined();
    expect(o.auditAccess).toBeUndefined();
    expect(o.maxConcurrentSessions).toEqual({ value: 200, expires_at: END });
  });

  test('managedModels is always stated, including when the plan withholds it', () => {
    expect(temporaryAccessOverrides(PLAN_CATALOG.team!, END).managedModels).toEqual({
      value: false,
      expires_at: END,
    });
  });

  test('every key it writes is one the primitive declares it owns', () => {
    const owned = new Set<string>(TEMPORARY_ACCESS_OVERRIDE_KEYS);
    for (const plan of Object.values(PLAN_CATALOG)) {
      for (const key of Object.keys(temporaryAccessOverrides(plan, END))) {
        expect(owned.has(key)).toBe(true);
      }
    }
  });
});

describe('grantTemporaryAccess', () => {
  test('writes expiring overrides, the legacy trial columns, and an expiring credit grant', async () => {
    grantCalls.length = 0;
    storedRow = null;
    const result = await grantTemporaryAccess({
      accountId: 'acct_1',
      planKey: 'enterprise',
      seats: 4,
      durationDays: 30,
    });

    // Overrides: the whole plan, every entry stamped with the window's end.
    const stored = storedRow!.entitlementOverrides as Record<string, unknown>;
    expect((stored.sso as { expires_at: string }).expires_at).toBe(result.endsAt);
    expect((stored.maxConcurrentSessions as { value: number }).value).toBe(5000);

    // Legacy trial columns, unchanged — the overlay and the console still read them.
    expect(storedRow!.trialStatus).toBe('active');
    expect(storedRow!.trialTier).toBe('enterprise');
    expect(storedRow!.trialSeats).toBe(4);
    expect(storedRow!.trialEndsAt).toBe(result.endsAt);

    // Credits default to $25/seat and die with the window.
    expect(result.creditGranted).toBe(100);
    expect(grantCalls).toHaveLength(1);
    expect(grantCalls[0]!.amount).toBe(100);
    expect(grantCalls[0]!.isExpiring).toBe(true);
    expect(grantCalls[0]!.opts?.expiresAt).toBe(result.endsAt);
  });

  test('the grant lapses by arithmetic — every entry is dead one ms after the end', async () => {
    grantCalls.length = 0;
    storedRow = null;
    const result = await grantTemporaryAccess({
      accountId: 'acct_1',
      planKey: 'enterprise',
      seats: 1,
      durationDays: 7,
    });
    const endMs = new Date(result.endsAt).getTime();
    for (const key of TEMPORARY_ACCESS_OVERRIDE_KEYS) {
      const during = readOverride(result.overrides, key, endMs - 1);
      const after = readOverride(result.overrides, key, endMs + 1);
      if (during !== undefined) expect(after).toBeUndefined();
    }
    expect(readOverride(result.overrides, 'sso', endMs - 1)).toBe(true);
    expect(readOverride(result.overrides, 'sso', endMs + 1)).toBeUndefined();
  });

  // Re-granting must not leave the PREVIOUS grant's key behind carrying the
  // previous grant's expiry: an Enterprise pilot followed by a Team pilot would
  // otherwise keep SSO alive on the Enterprise timetable.
  test('a re-grant replaces the keys it owns and keeps the ones it does not', async () => {
    grantCalls.length = 0;
    storedRow = null;
    await grantTemporaryAccess({
      accountId: 'acct_1',
      planKey: 'enterprise',
      seats: 1,
      durationDays: 30,
    });
    // An unrelated operator override that the primitive must not touch.
    storedRow!.entitlementOverrides = {
      ...(storedRow!.entitlementOverrides as Record<string, unknown>),
      computeRateMultiplier: { value: 0 },
    };

    const second = await grantTemporaryAccess({
      accountId: 'acct_1',
      planKey: 'per_seat',
      seats: 1,
      durationDays: 5,
    });
    const stored = storedRow!.entitlementOverrides as Record<string, unknown>;
    expect(stored.sso).toBeUndefined();
    expect(stored.scim).toBeUndefined();
    expect(stored.computeRateMultiplier).toEqual({ value: 0 });
    expect((stored.maxConcurrentSessions as { value: number }).value).toBe(200);
    expect((stored.managedModels as { expires_at: string }).expires_at).toBe(second.endsAt);
  });

  test('rejects an invalid plan key / seats / duration instead of writing anything', async () => {
    storedRow = null;
    for (const input of [
      { planKey: 'free', seats: 1, durationDays: 30 },
      { planKey: 'per_seat', seats: 0, durationDays: 30 },
      { planKey: 'per_seat', seats: 1, durationDays: 0 },
    ]) {
      await expect(grantTemporaryAccess({ accountId: 'acct_1', ...input })).rejects.toThrow();
    }
    expect(storedRow).toBeNull();
  });
});

describe('grantTrial delegates without changing its own contract', () => {
  test('the wallet grant stays opt-in (default 0), not $25/seat', async () => {
    grantCalls.length = 0;
    storedRow = null;
    const result = await grantTrial({
      accountId: 'acct_1',
      tierKey: 'per_seat',
      seats: 8,
      durationDays: 14,
    });
    expect(result.creditGranted).toBe(0);
    expect(grantCalls).toHaveLength(0);
    // …and it still records the trial the admin console reads.
    expect(result.current.status).toBe('active');
    expect(result.current.tier).toBe('per_seat');
    expect(result.current.seats).toBe(8);
  });

  test('it now also writes the expiring overrides for the trial tier', async () => {
    grantCalls.length = 0;
    storedRow = null;
    await grantTrial({
      accountId: 'acct_1',
      tierKey: 'enterprise',
      seats: 1,
      durationDays: 21,
      creditGrant: 10,
    });
    const stored = storedRow!.entitlementOverrides as Record<string, unknown>;
    expect((stored.sso as { value: boolean }).value).toBe(true);
    expect((stored.sso as { expires_at: string }).expires_at).toBe(
      storedRow!.trialEndsAt as string,
    );
    expect(grantCalls[0]!.amount).toBe(10);
  });
});

describe('ending a grant early takes its overrides with it', () => {
  test('revokeTrial strips the derived keys and keeps the unrelated ones', async () => {
    grantCalls.length = 0;
    storedRow = null;
    await grantTrial({
      accountId: 'acct_1',
      tierKey: 'enterprise',
      seats: 1,
      durationDays: 90,
    });
    storedRow!.entitlementOverrides = {
      ...(storedRow!.entitlementOverrides as Record<string, unknown>),
      computeRateMultiplier: { value: 0.5 },
    };

    const { revokeTrial } = await import('../billing/services/trial-admin');
    const result = await revokeTrial('acct_1');
    expect(result.current.status).toBe('revoked');
    // Without this, "revoked" would not take effect until the date the revoke
    // was supposed to bring forward.
    expect(storedRow!.entitlementOverrides).toEqual({ computeRateMultiplier: { value: 0.5 } });
  });

  test('markTrialConverted does the same — a paid plan decides its own entitlements', async () => {
    grantCalls.length = 0;
    storedRow = null;
    await grantTrial({ accountId: 'acct_1', tierKey: 'enterprise', seats: 1, durationDays: 90 });

    const { markTrialConverted } = await import('../billing/services/trial-admin');
    expect(await markTrialConverted('acct_1')).toBe(true);
    expect(storedRow!.trialStatus).toBe('converted');
    expect(storedRow!.entitlementOverrides).toEqual({});
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
