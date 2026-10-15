import { describe, expect, test } from 'bun:test';

// resolveBillingFromRow (billing/services/resolve-billing.ts) states an
// account's whole billing situation from one credit_accounts row: which plan it
// behaves as, where that came from, its effective entitlements after the
// account-level overrides, and its concurrent-session cap.
//
// These tests pin its semantics (.agents/skills/billing/references/plans-and-access.md):
// the trial overlay (with its lazy expiry), the legacy-key aliasing to
// `credits`, the 14-day SSO/SCIM grace after an Enterprise trial, and the
// per-feature overrides — the one exception mechanism.
//
// No mocks: the module is pure by construction. If it ever needs one, it has
// stopped being pure and that is the bug.

import { PLAN_CATALOG } from '../billing/services/plan-catalog';
import {
  type BillingRow,
  resolveBillingFromRow,
} from '../billing/services/resolve-billing';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

/** A live paid subscription. Resolution never reads it: the stored tier decides. */
const LIVE_SUB = {
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
      expect('limits' in r).toBe(false);
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
    });
  }

  test('every legacy plan key resolves to the credits record', () => {
    for (const key of ['per_seat', 'pro', 'team', 'tier_2_20', 'tier_25_200', 'tier_150_1200']) {
      const r = resolveBillingFromRow({ tier: key }, NOW);
      expect(r.plan.key).toBe('credits');
      expect(r.source).toBe('stored');
      expect(r.entitlements.managedModels).toBe(true);
    }
  });

  test('null tier reads as none, not free', () => {
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
    // The plan's other features end; sign-in (SSO) is kept by the grace.
    expect(r.entitlements.rbac).toBe(false);
    expect(r.entitlements.sso).toBe(true);
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

  test.each([
    ['ends exactly now', iso(0)],
    ['has an unparseable end date', 'garbage'],
  ])('a trial that %s does not grant', (_name, trialEndsAt) => {
    const r = resolveBillingFromRow(
      { tier: 'free', trialStatus: 'active', trialTier: 'enterprise', trialEndsAt },
      NOW,
    );
    expect(r.plan.key).toBe('free');
    expect(r.source).toBe('stored');
  });

  test('trial outranks a live subscription row', () => {
    const r = resolveBillingFromRow(
      {
        tier: 'free',
        ...LIVE_SUB,
        trialStatus: 'active',
        trialTier: 'enterprise',
        trialEndsAt: iso(HOUR),
      },
      NOW,
    );
    expect(r.plan.key).toBe('enterprise');
    expect(r.source).toBe('trial');
  });

  test('a legacy trial tier key resolves to credits', () => {
    const r = resolveBillingFromRow(
      { tier: 'free', trialStatus: 'active', trialTier: 'tier_25_200', trialEndsAt: iso(HOUR) },
      NOW,
    );
    expect(r.plan.key).toBe('credits');
    expect(r.source).toBe('trial');
  });
});

describe('no self-heal from the subscription row', () => {
  test('a non-paid stored tier with a live subscription stays as stored', () => {
    for (const tier of ['free', 'none']) {
      const r = resolveBillingFromRow({ tier, ...LIVE_SUB }, NOW);
      expect(r.plan.key).toBe(tier);
      expect(r.source).toBe('stored');
    }
  });
});

describe('removed flags have no effect', () => {
  test('enterprise_entitled, demo_enterprise and managed_models_override on the row change nothing', () => {
    const stale = {
      tier: 'free',
      enterpriseEntitled: true,
      demoEnterprise: true,
      managedModelsOverride: true,
    } as unknown as BillingRow;
    expect(resolveBillingFromRow(stale, NOW)).toEqual(resolveBillingFromRow({ tier: 'free' }, NOW));
  });

  test('their JSONB keys are ignored too', () => {
    const r = resolveBillingFromRow(
      {
        tier: 'free',
        entitlementOverrides: {
          enterpriseEntitled: { value: true },
          demoEnterprise: { value: true },
          managedModelsOverride: { value: true },
          computeRateMultiplier: { value: 0 },
        },
      },
      NOW,
    );
    expect(r).toEqual(resolveBillingFromRow({ tier: 'free' }, NOW));
  });

  test('the Enterprise plan itself grants every enterprise feature', () => {
    const e = resolveBillingFromRow({ tier: 'enterprise' }, NOW).entitlements;
    expect([e.sso, e.scim, e.rbac, e.auditAccess, e.branding, e.managedModels]).toEqual([true, true, true, true, true, true]);
  });
});

describe('SSO/SCIM grace after an Enterprise trial', () => {
  const ended = (msAgo: number, status = 'expired') =>
    ({ tier: 'free', trialStatus: status, trialTier: 'enterprise', trialEndsAt: iso(-msAgo) }) satisfies BillingRow;

  test('for 14 days after the end, SSO and SCIM stay on and nothing else does', () => {
    const r = resolveBillingFromRow(ended(HOUR), NOW);
    expect(r.plan.key).toBe('free');
    expect(r.entitlements.sso).toBe(true);
    expect(r.entitlements.scim).toBe(true);
    expect(r.entitlements.rbac).toBe(false);
    expect(r.entitlements.managedModels).toBe(false);
    expect(r.grace).toEqual({ reason: 'trial_ended', endsAt: iso(-HOUR + 14 * 24 * HOUR) });
  });

  test('lazy like expiry: an active status past its end already gets the grace', () => {
    expect(resolveBillingFromRow(ended(HOUR, 'active'), NOW).grace?.reason).toBe('trial_ended');
  });

  test('day 15 has no grace', () => {
    const r = resolveBillingFromRow(ended(15 * 24 * HOUR), NOW);
    expect(r.grace).toBeNull();
    expect(r.entitlements.sso).toBe(false);
  });

  test('a revoked trial gets no grace: a revoke is deliberate', () => {
    expect(resolveBillingFromRow(ended(HOUR, 'revoked'), NOW).grace).toBeNull();
  });

  test('a Credits trial has no SSO to keep, so no grace', () => {
    const r = resolveBillingFromRow({ tier: 'free', trialStatus: 'expired', trialTier: 'credits', trialEndsAt: iso(-HOUR) }, NOW);
    expect(r.grace).toBeNull();
  });

  test('a per-feature override still wins over the grace', () => {
    const r = resolveBillingFromRow({ ...ended(HOUR), entitlementOverrides: { sso: { value: false } } }, NOW);
    expect(r.entitlements.sso).toBe(false);
    expect(r.entitlements.scim).toBe(true);
  });
});

describe('removed maxConcurrentSessions column', () => {
  test('a stale value on the row changes nothing and no limits are resolved', () => {
    const stale = { tier: 'free', maxConcurrentSessions: 900 } as unknown as BillingRow;
    const r = resolveBillingFromRow(stale, NOW);
    expect(r).toEqual(resolveBillingFromRow({ tier: 'free' }, NOW));
    expect('limits' in r).toBe(false);
  });
});

// ─── entitlement_overrides: per-feature exceptions ──────────────────────────

describe('per-feature overrides', () => {
  test('one capability can be switched OFF on an Enterprise account', () => {
    const r = resolveBillingFromRow({ tier: 'enterprise', entitlementOverrides: { sso: { value: false } } }, NOW);
    expect(r.entitlements.sso).toBe(false);
    expect(r.entitlements.scim).toBe(true);
  });

  test('one capability can be switched ON for a Credits account', () => {
    const r = resolveBillingFromRow({ tier: 'credits', entitlementOverrides: { sso: { value: true } } }, NOW);
    expect(r.entitlements.sso).toBe(true);
    expect(r.entitlements.scim).toBe(false);
  });

  test('managedModels can be withdrawn from a plan that includes it', () => {
    const r = resolveBillingFromRow({ tier: 'credits', entitlementOverrides: { managedModels: { value: false } } }, NOW);
    expect(r.entitlements.managedModels).toBe(false);
  });

  test('an expired override stops applying', () => {
    const r = resolveBillingFromRow(
      { tier: 'credits', entitlementOverrides: { sso: { value: true, expires_at: iso(-HOUR) } } },
      NOW,
    );
    expect(r.entitlements.sso).toBe(false);
  });

  test('a malformed column cannot break resolution — it reads as no overrides', () => {
    for (const bad of ['x', 7, [], { sso: 'yes' }]) {
      expect(resolveBillingFromRow({ tier: 'credits', entitlementOverrides: bad }, NOW).entitlements).toEqual(
        resolveBillingFromRow({ tier: 'credits' }, NOW).entitlements,
      );
    }
  });
});

describe('display naming', () => {
  test('family label, never a sublabel; legacy keys read as Credits', () => {
    expect(resolveBillingFromRow({ tier: 'free' }, NOW).display).toEqual({
      label: 'Free',
      sublabel: null,
    });
    expect(resolveBillingFromRow({ tier: 'enterprise' }, NOW).display).toEqual({
      label: 'Enterprise',
      sublabel: null,
    });
    expect(resolveBillingFromRow({ tier: 'credits' }, NOW).display).toEqual({
      label: 'Credits',
      sublabel: null,
    });
    for (const tier of ['per_seat', 'tier_25_200']) {
      expect(resolveBillingFromRow({ tier }, NOW).display).toEqual({
        label: 'Credits',
        sublabel: null,
      });
    }
  });
});

describe('purity', () => {
  test('the same row and clock always resolve identically', () => {
    const row: BillingRow = { tier: 'free', ...LIVE_SUB };
    expect(resolveBillingFromRow(row, NOW)).toEqual(resolveBillingFromRow(row, NOW));
  });

  test('mutating the returned entitlements cannot corrupt the catalog', () => {
    const r = resolveBillingFromRow({ tier: 'free' }, NOW);
    r.entitlements.managedModels = true;
    expect(PLAN_CATALOG.free?.entitlements.managedModels).toBe(false);
    expect(resolveBillingFromRow({ tier: 'free' }, NOW).entitlements.managedModels).toBe(false);
  });
});
