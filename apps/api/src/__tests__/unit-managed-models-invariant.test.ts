import { describe, expect, test } from 'bun:test';

// THE managed-models invariant (resolve-billing.ts `paysForManagedModels`):
// Kortix-managed models are sold, never given. Only a paid billing plan or a
// licensed Enterprise contract carries them. 2026-10-19: Free ran managed
// models on its included credits through three exemptions at once.
//
// This sweeps every plan key the catalog and the legacy aliases know, an
// unknown key and a missing row, against every Enterprise state and every
// managed-models override. A new plan key, override or Enterprise mode that
// hands Free managed models turns this red.

import { PLAN_CATALOG } from '../billing/services/plan-catalog';
import { type BillingRow, resolveBillingFromRow } from '../billing/services/resolve-billing';
import { LEGACY_PAID_PLAN_KEYS } from '../billing/services/tier-facts';

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const FUTURE = new Date(NOW + 86_400_000).toISOString();
const PAST = new Date(NOW - 86_400_000).toISOString();

const TIERS: (string | null)[] = [...Object.keys(PLAN_CATALOG), ...LEGACY_PAID_PLAN_KEYS, 'unknown_tier', null];
const ENTERPRISE: Pick<BillingRow, 'enterpriseEntitled' | 'demoEnterprise'>[] = [
  {},
  { demoEnterprise: true },
  { enterpriseEntitled: true },
  { enterpriseEntitled: true, demoEnterprise: true },
];
const OVERRIDES: unknown[] = [
  undefined,
  { managedModels: { value: true } },
  { managedModels: { value: true, expires_at: FUTURE } },
  { managedModels: { value: true, expires_at: PAST } },
  { managedModels: { value: false } },
];

function rows(): BillingRow[] {
  return TIERS.flatMap((tier) =>
    ENTERPRISE.flatMap((enterprise) =>
      OVERRIDES.map((entitlementOverrides) => ({ tier, ...enterprise, entitlementOverrides })),
    ),
  );
}

describe('managed models are sold, never given', () => {
  test('Free and No Plan never get managed models, whatever the override or Enterprise demo', () => {
    for (const row of rows()) {
      const resolved = resolveBillingFromRow(row, NOW);
      if (resolved.plan.family === 'free' && resolved.enterprise !== 'licensed') {
        expect({ tier: row.tier, row, managedModels: resolved.entitlements.managedModels }).toEqual({
          tier: row.tier,
          row,
          managedModels: false,
        });
      }
    }
  });

  test('a missing credit account gets no managed models', () => {
    expect(resolveBillingFromRow(null, NOW).entitlements.managedModels).toBe(false);
  });

  test('every paid plan and a licensed Enterprise contract get them, unless an override withdraws them', () => {
    for (const row of rows()) {
      const resolved = resolveBillingFromRow(row, NOW);
      const paid = resolved.plan.family !== 'free' || resolved.enterprise === 'licensed';
      const withdrawn = (row.entitlementOverrides as { managedModels?: { value: boolean } } | undefined)?.managedModels
        ?.value === false;
      expect({ tier: row.tier, row, managedModels: resolved.entitlements.managedModels }).toEqual({
        tier: row.tier,
        row,
        managedModels: paid && !withdrawn,
      });
    }
  });

  test('the Free catalog record itself carries no managed models', () => {
    expect(PLAN_CATALOG.free!.entitlements.managedModels).toBe(false);
    expect(PLAN_CATALOG.none!.entitlements.managedModels).toBe(false);
  });
});
