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
  // `enterprise` is no longer a billing plan: see the Enterprise layer below.
  for (const key of ALL_KEYS.filter((k) => k !== 'enterprise')) {
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
  test('managed_models_override on the row changes nothing', () => {
    const stale = {
      tier: 'free',
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
    // A legacy Enterprise tier is licensed on the Credits plan.
    expect(resolveBillingFromRow({ tier: 'enterprise' }, NOW).display).toEqual({
      label: 'Credits',
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
    r.entitlements.sso = true;
    expect(PLAN_CATALOG.free?.entitlements.sso).toBe(false);
    expect(resolveBillingFromRow({ tier: 'free' }, NOW).entitlements.sso).toBe(false);
  });
});

describe('byokFee entitlement', () => {
  test('on by default for Free and Credits, off on Enterprise', () => {
    expect(resolveBillingFromRow({ tier: 'free' }, NOW).entitlements.byokFee).toBe(true);
    expect(resolveBillingFromRow({ tier: 'credits' }, NOW).entitlements.byokFee).toBe(true);
    expect(resolveBillingFromRow({ tier: 'enterprise' }, NOW).entitlements.byokFee).toBe(false);
  });

  test('an operator override switches it per account, either way', () => {
    const waived = resolveBillingFromRow({ tier: 'credits', entitlementOverrides: { byokFee: { value: false } } }, NOW);
    expect(waived.entitlements.byokFee).toBe(false);
    const charged = resolveBillingFromRow({ tier: 'enterprise', entitlementOverrides: { byokFee: { value: true } } }, NOW);
    expect(charged.entitlements.byokFee).toBe(true);
  });
});

describe('Enterprise is a feature layer: off, demo, licensed', () => {
  test('off by default: the plan alone decides', () => {
    const r = resolveBillingFromRow({ tier: 'credits' }, NOW);
    expect(r.enterprise).toBe('off');
    expect(r.entitlements.sso).toBe(false);
  });

  test('demo turns the Enterprise features on and keeps the plan, its limits and the BYOK fee', () => {
    const r = resolveBillingFromRow({ tier: 'free', demoEnterprise: true }, NOW);
    expect(r.enterprise).toBe('demo');
    expect(r.plan.key).toBe('free');
    expect(r.features.key).toBe('free');
    expect([r.entitlements.sso, r.entitlements.scim, r.entitlements.rbac, r.entitlements.auditAccess, r.entitlements.branding]).toEqual([true, true, true, true, true]);
    expect(r.entitlements.managedModels).toBe(true);
    expect(r.entitlements.byokFee).toBe(true);
  });

  test('licensed: Enterprise features and limits, no BYOK fee, billing plan unchanged', () => {
    const r = resolveBillingFromRow({ tier: 'credits', enterpriseEntitled: true, demoEnterprise: true }, NOW);
    expect(r.enterprise).toBe('licensed');
    expect(r.plan.key).toBe('credits');
    expect(r.features.key).toBe('enterprise');
    expect(r.entitlements.sso).toBe(true);
    expect(r.entitlements.byokFee).toBe(false);
  });

  test('a legacy tier=enterprise row reads as licensed on the Credits plan', () => {
    const r = resolveBillingFromRow({ tier: 'enterprise' }, NOW);
    expect(r.enterprise).toBe('licensed');
    expect(r.plan.key).toBe('credits');
  });

  test('an override still wins over Demo and Licensed', () => {
    const r = resolveBillingFromRow({ tier: 'free', demoEnterprise: true, entitlementOverrides: { sso: { value: false } } }, NOW);
    expect(r.entitlements.sso).toBe(false);
    expect(r.entitlements.scim).toBe(true);
  });

  test('trial columns grant nothing any more', () => {
    const r = resolveBillingFromRow({ tier: 'free', trialStatus: 'active', trialTier: 'enterprise', trialEndsAt: iso(HOUR) } as never, NOW);
    expect(r.enterprise).toBe('off');
    expect(r.entitlements.sso).toBe(false);
    expect(r.source).toBe('stored');
  });
});
