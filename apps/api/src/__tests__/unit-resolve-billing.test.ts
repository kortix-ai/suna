import { describe, expect, test } from 'bun:test';

// resolveBillingFromRow (billing/services/resolve-billing.ts) states an
// account's whole billing situation from one credit_accounts row: which plan it
// behaves as, where that came from, its effective entitlements after the
// account-level overrides, and its concurrent-session cap.
//
// It replaces nothing yet. These tests pin the semantics it is required to
// reproduce — the trial overlay and per-seat self-heal from
// effective-tier.ts:93-100, the enterprise/demo/managed-models overrides from
// entitlements.ts:107-140, and the session-limit override from
// shared/account-limits.ts:151-160 — so the consumer flip in the next PR is a
// mechanical swap and not a behavior change.
//
// No mocks: the module is pure by construction. If it ever needs one, it has
// stopped being pure and that is the bug.

import { PLAN_CATALOG } from '../billing/services/plan-catalog';
import { type BillingRow, resolveBillingFromRow } from '../billing/services/resolve-billing';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

/** A live seat subscription — the precondition for the per-seat self-heal. */
const LIVE_SEAT_SUB = {
  billingModel: 'per_seat',
  stripeSubscriptionId: 'sub_live',
  stripeSubscriptionStatus: 'active',
} satisfies Partial<BillingRow>;

const ALL_KEYS = Object.keys(PLAN_CATALOG);

describe('no row', () => {
  test('null row → none / no_account, fail-closed', () => {
    for (const row of [null, undefined]) {
      const r = resolveBillingFromRow(row, NOW);
      expect(r.plan.key).toBe('none');
      expect(r.source).toBe('no_account');
      expect(r.entitlements).toEqual(PLAN_CATALOG.none?.entitlements as never);
      expect(r.limits.concurrentSessions).toEqual({ value: 50, source: 'plan' });
    }
  });
});

describe('stored tier', () => {
  for (const key of ALL_KEYS) {
    test(`tier='${key}' resolves to its own record, source 'stored'`, () => {
      const record = PLAN_CATALOG[key] as NonNullable<(typeof PLAN_CATALOG)[string]>;
      const r = resolveBillingFromRow({ tier: key }, NOW);
      expect(r.plan.key).toBe(key);
      expect(r.source).toBe('stored');
      expect(r.entitlements).toEqual(record.entitlements);
      expect(r.limits.concurrentSessions).toEqual({
        value: record.limits.concurrentSessions,
        source: 'plan',
      });
    });
  }

  test('null tier reads as none, not free (matches resolveEffectiveTier)', () => {
    const r = resolveBillingFromRow({ tier: null }, NOW);
    expect(r.plan.key).toBe('none');
    expect(r.source).toBe('stored');
  });

  test('unknown tier string falls back to the none record without throwing', () => {
    const r = resolveBillingFromRow({ tier: 'tier_from_the_future' }, NOW);
    expect(r.plan.key).toBe('none');
    expect(r.source).toBe('stored');
  });
});

describe('trial overlay', () => {
  test('active trial behaves as the trial tier, not the stored tier', () => {
    const r = resolveBillingFromRow(
      {
        tier: 'free',
        trialStatus: 'active',
        trialTier: 'enterprise',
        trialEndsAt: iso(24 * HOUR),
      },
      NOW,
    );
    expect(r.plan.key).toBe('enterprise');
    expect(r.source).toBe('trial');
    expect(r.entitlements.sso).toBe(true);
    expect(r.entitlements.managedModels).toBe(true);
    expect(r.limits.concurrentSessions.value).toBe(5000);
  });

  test('expired trial falls back to the stored tier', () => {
    const r = resolveBillingFromRow(
      {
        tier: 'free',
        trialStatus: 'active',
        trialTier: 'enterprise',
        trialEndsAt: iso(-1),
      },
      NOW,
    );
    expect(r.plan.key).toBe('free');
    expect(r.source).toBe('stored');
    expect(r.entitlements.sso).toBe(false);
  });

  test('non-active trial_status never grants, whatever the end date says', () => {
    for (const status of ['none', 'expired', 'revoked', 'converted']) {
      const r = resolveBillingFromRow(
        { tier: 'free', trialStatus: status, trialTier: 'pro', trialEndsAt: iso(24 * HOUR) },
        NOW,
      );
      expect(r.plan.key).toBe('free');
      expect(r.source).toBe('stored');
    }
  });

  test('trial with an unknown or missing tier does not grant', () => {
    const unknown = resolveBillingFromRow(
      { tier: 'free', trialStatus: 'active', trialTier: 'nope', trialEndsAt: iso(24 * HOUR) },
      NOW,
    );
    expect(unknown.plan.key).toBe('free');
    const missing = resolveBillingFromRow(
      { tier: 'free', trialStatus: 'active', trialTier: 'pro', trialEndsAt: null },
      NOW,
    );
    expect(missing.plan.key).toBe('free');
  });

  test('trial outranks the per-seat self-heal', () => {
    const r = resolveBillingFromRow(
      {
        tier: 'free',
        ...LIVE_SEAT_SUB,
        trialStatus: 'active',
        trialTier: 'enterprise',
        trialEndsAt: iso(HOUR),
      },
      NOW,
    );
    expect(r.plan.key).toBe('enterprise');
    expect(r.source).toBe('trial');
  });
});

describe('per-seat self-heal', () => {
  test('non-paid stored tier + live seat subscription → per_seat', () => {
    for (const tier of ['free', 'none', null]) {
      const r = resolveBillingFromRow({ tier, ...LIVE_SEAT_SUB }, NOW);
      expect(r.plan.key).toBe('per_seat');
      expect(r.source).toBe('per_seat_selfheal');
      expect(r.entitlements.managedModels).toBe(true);
      expect(r.entitlements.metersCompute).toBe(true);
      expect(r.limits.concurrentSessions).toEqual({ value: 200, source: 'plan' });
    }
  });

  test('canceled / unpaid subscription does not self-heal', () => {
    for (const status of ['canceled', 'unpaid']) {
      const r = resolveBillingFromRow(
        { tier: 'free', ...LIVE_SEAT_SUB, stripeSubscriptionStatus: status },
        NOW,
      );
      expect(r.plan.key).toBe('free');
      expect(r.source).toBe('stored');
    }
  });

  test('no subscription id does not self-heal', () => {
    const r = resolveBillingFromRow(
      { tier: 'free', billingModel: 'per_seat', stripeSubscriptionStatus: 'active' },
      NOW,
    );
    expect(r.plan.key).toBe('free');
    expect(r.source).toBe('stored');
  });

  test('an already-paid stored tier is left alone (no self-heal, source stored)', () => {
    const r = resolveBillingFromRow({ tier: 'tier_25_200', ...LIVE_SEAT_SUB }, NOW);
    expect(r.plan.key).toBe('tier_25_200');
    expect(r.source).toBe('stored');
  });
});

describe('enterprise entitlement overlays', () => {
  test('enterpriseEntitled on per_seat → all entitlements true, plan stays per_seat', () => {
    const r = resolveBillingFromRow({ tier: 'per_seat', enterpriseEntitled: true }, NOW);
    expect(r.plan.key).toBe('per_seat');
    expect(r.source).toBe('stored');
    expect(r.entitlements.sso).toBe(true);
    expect(r.entitlements.scim).toBe(true);
    expect(r.entitlements.rbac).toBe(true);
    expect(r.entitlements.auditAccess).toBe(true);
    // The overlay grants the enterprise IDENTITY surface only. Plan-shaped
    // facts stay the plan's.
    expect(r.limits.concurrentSessions).toEqual({ value: 200, source: 'plan' });
    expect(r.entitlements.metersCompute).toBe(true);
  });

  test('demoEnterprise on free → all entitlements true, plan stays free', () => {
    const r = resolveBillingFromRow({ tier: 'free', demoEnterprise: true }, NOW);
    expect(r.plan.key).toBe('free');
    expect(r.entitlements.sso).toBe(true);
    expect(r.entitlements.auditAccess).toBe(true);
    // Demo is an identity preview, not a plan upgrade: no managed models.
    expect(r.entitlements.managedModels).toBe(false);
    expect(r.limits.concurrentSessions.value).toBe(50);
  });

  test('both flags false → plan gating stands', () => {
    const r = resolveBillingFromRow(
      { tier: 'per_seat', enterpriseEntitled: false, demoEnterprise: false },
      NOW,
    );
    expect(r.entitlements.sso).toBe(false);
    expect(r.entitlements.scim).toBe(false);
  });

  test('a genuine enterprise plan needs no flag', () => {
    const r = resolveBillingFromRow({ tier: 'enterprise' }, NOW);
    expect(r.entitlements.rbac).toBe(true);
  });
});

describe('managedModelsOverride is tri-state', () => {
  test('true grants managed models to a plan that does not include them', () => {
    const r = resolveBillingFromRow({ tier: 'free', managedModelsOverride: true }, NOW);
    expect(r.plan.key).toBe('free');
    expect(r.entitlements.managedModels).toBe(true);
  });

  test('false withdraws managed models from a plan that does include them', () => {
    const r = resolveBillingFromRow({ tier: 'pro', managedModelsOverride: false }, NOW);
    expect(r.plan.key).toBe('pro');
    expect(r.entitlements.managedModels).toBe(false);
  });

  test('null / undefined defers to the plan', () => {
    expect(
      resolveBillingFromRow({ tier: 'pro', managedModelsOverride: null }, NOW).entitlements
        .managedModels,
    ).toBe(true);
    expect(resolveBillingFromRow({ tier: 'free' }, NOW).entitlements.managedModels).toBe(false);
  });
});

describe('maxConcurrentSessions override', () => {
  test('a positive override wins over the plan cap, in both directions', () => {
    const up = resolveBillingFromRow({ tier: 'free', maxConcurrentSessions: 900 }, NOW);
    expect(up.limits.concurrentSessions).toEqual({ value: 900, source: 'account_override' });
    const down = resolveBillingFromRow({ tier: 'enterprise', maxConcurrentSessions: 5 }, NOW);
    expect(down.limits.concurrentSessions).toEqual({ value: 5, source: 'account_override' });
  });

  test('non-positive / null / non-finite overrides fall back to the plan cap', () => {
    for (const value of [0, -1, null, Number.NaN]) {
      const r = resolveBillingFromRow({ tier: 'free', maxConcurrentSessions: value }, NOW);
      expect(r.limits.concurrentSessions).toEqual({ value: 50, source: 'plan' });
    }
  });

  test('a fractional override floors, like resolveAccountLimitInfo', () => {
    const r = resolveBillingFromRow({ tier: 'free', maxConcurrentSessions: 7.9 }, NOW);
    expect(r.limits.concurrentSessions.value).toBe(7);
  });
});

describe('display naming', () => {
  test('family label, with a grandfathered sublabel where one applies', () => {
    expect(resolveBillingFromRow({ tier: 'free' }, NOW).display).toEqual({
      label: 'Free',
      sublabel: null,
    });
    expect(resolveBillingFromRow({ tier: 'enterprise' }, NOW).display).toEqual({
      label: 'Enterprise',
      sublabel: null,
    });
    expect(resolveBillingFromRow({ tier: 'per_seat' }, NOW).display).toEqual({
      label: 'Team',
      sublabel: '$40/seat/mo · grandfathered',
    });
    expect(resolveBillingFromRow({ tier: 'tier_25_200' }, NOW).display).toEqual({
      label: 'Team',
      sublabel: '$200/mo · grandfathered',
    });
  });
});

describe('purity', () => {
  test('the same row and clock always resolve identically', () => {
    const row: BillingRow = { tier: 'free', ...LIVE_SEAT_SUB, maxConcurrentSessions: 12 };
    expect(resolveBillingFromRow(row, NOW)).toEqual(resolveBillingFromRow(row, NOW));
  });

  test('mutating the returned entitlements cannot corrupt the catalog', () => {
    const r = resolveBillingFromRow({ tier: 'free' }, NOW);
    r.entitlements.managedModels = true;
    expect(PLAN_CATALOG.free?.entitlements.managedModels).toBe(false);
    expect(resolveBillingFromRow({ tier: 'free' }, NOW).entitlements.managedModels).toBe(false);
  });
});
