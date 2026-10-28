import { describe, expect, test } from 'bun:test';
import { getTierEntitlements } from '../billing/services/tiers';

const tierHasEntitlement = (tier: string, key: keyof ReturnType<typeof getTierEntitlements>) =>
  getTierEntitlements(tier)[key] === true;

// Locks in the plan-gating contract for the enterprise surfaces: SAML SSO,
// SCIM, groups + custom roles (`rbac`), and audit access. Only the
// sales-assigned `enterprise` tier unlocks them; every self-serve / legacy
// tier is gated (rbac re-gated 2026-07-09 — it was briefly open on every
// tier). The IAM route guard (requireEntitlement) and the /scim/v2
// data-plane middleware both resolve these per-plan gates, so these
// invariants ARE the access-control policy. Reads/revokes/deletes stay
// ungated route-side so downgraded accounts can unwind what they have.
describe('tier entitlements (enterprise gating)', () => {
  test('enterprise tier unlocks SSO + SCIM + RBAC + audit access', () => {
    expect(tierHasEntitlement('enterprise', 'sso')).toBe(true);
    expect(tierHasEntitlement('enterprise', 'scim')).toBe(true);
    expect(tierHasEntitlement('enterprise', 'rbac')).toBe(true);
    expect(tierHasEntitlement('enterprise', 'auditAccess')).toBe(true);
  });

  test('every non-enterprise tier: identity, rbac, and audit are all gated', () => {
    for (const t of [
      'none',
      'free',
      'credits',
      'pro',
      'per_seat',
      'tier_2_20',
      'tier_6_50',
      'tier_12_100',
      'tier_25_200',
      'tier_50_400',
      'tier_125_800',
      'tier_200_1000',
      'tier_150_1200',
    ]) {
      expect(tierHasEntitlement(t, 'sso')).toBe(false);
      expect(tierHasEntitlement(t, 'scim')).toBe(false);
      expect(tierHasEntitlement(t, 'rbac')).toBe(false);
      expect(tierHasEntitlement(t, 'auditAccess')).toBe(false);
    }
  });

  test('unknown tier names fail closed on every entitlement', () => {
    expect(tierHasEntitlement('does-not-exist', 'sso')).toBe(false);
    expect(tierHasEntitlement('does-not-exist', 'scim')).toBe(false);
    expect(getTierEntitlements('does-not-exist')).toEqual({
      sso: false,
      scim: false,
      rbac: false,
      auditAccess: false,
    });
  });

  test('a legacy plan key is gated exactly like credits', () => {
    for (const t of ['per_seat', 'pro', 'tier_25_200']) {
      expect(getTierEntitlements(t)).toEqual(getTierEntitlements('credits'));
    }
  });
});
