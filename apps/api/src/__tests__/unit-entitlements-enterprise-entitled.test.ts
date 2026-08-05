import { afterEach, describe, expect, mock, test } from 'bun:test';

// `enterprise_entitled` is the per-account, contracted-cloud Enterprise flag:
// when true the account resolves ALL enterprise entitlements (SAML SSO, SCIM,
// RBAC, audit access) regardless of its billing `tier`. This is the seam that
// lets a deal which is BOTH Enterprise (entitlements) AND per-seat (billing)
// hold both at once — `tier`/`billing_model` can be `per_seat` for Stripe seat
// reconciliation while `enterprise_entitled=true` keeps the identity surface on.
// Without it the per-seat Stripe webhook reconciliation clobbers `tier` to
// `per_seat` and strips SSO/SCIM/RBAC/audit on every ordinary subscription
// update. These invariants ARE the contract's access-control policy — the IAM
// route guards (requireEntitlement) and the SCIM data-plane middleware both
// call accountHasEntitlement / getAccountEntitlements.

// Stub the credit-account repo before loading the resolver, so we exercise the
// enterprise_entitled override branch without a database. `fakeRow` stands in
// for the row that getCreditAccount() would return.
let fakeRow:
  | { tier?: string; enterpriseEntitled?: boolean; demoEnterprise?: boolean }
  | null = null;
mock.module('../billing/repositories/credit-accounts', () => ({
  getCreditAccount: async () => fakeRow,
}));

// Self-host ENTERPRISE_LICENSE_AVAILABLE bypass — a getter so each test can
// flip it without re-mocking the module. Everything else entitlements.ts might
// read from config stays absent; it only ever touches this one field.
let enterpriseLicenseAvailable = false;
mock.module('../config', () => ({
  config: {
    get ENTERPRISE_LICENSE_AVAILABLE() {
      return enterpriseLicenseAvailable;
    },
  },
}));

const { accountHasEntitlement, getAccountEntitlements } = await import(
  '../billing/services/entitlements'
);

// The contracted-Enterprise flag must unlock the ENTIRE enterprise surface
// regardless of billing tier, stay fail-closed when off / unprovisioned, never
// suppress a genuine `tier='enterprise'`, and coexist with the self-serve demo
// flag. Resolution order: license → enterprise_entitled → demo_enterprise → tier.
describe('enterprise_entitled — contracted cloud Enterprise override', () => {
  test('flag on → every entitlement unlocked even when billing tier is per_seat', async () => {
    // The exact LibreMax shape: enterprise entitlements + per-seat billing.
    fakeRow = { tier: 'per_seat', enterpriseEntitled: true, demoEnterprise: false };
    expect(await accountHasEntitlement('acct', 'sso')).toBe(true);
    expect(await accountHasEntitlement('acct', 'scim')).toBe(true);
    expect(await accountHasEntitlement('acct', 'rbac')).toBe(true);
    expect(await accountHasEntitlement('acct', 'auditAccess')).toBe(true);
    const ent = await getAccountEntitlements('acct');
    expect(ent).toEqual({ sso: true, scim: true, rbac: true, auditAccess: true });
  });

  test('flag on → every entitlement unlocked even when billing tier is free', async () => {
    // An operator can flag the account at sign-up before any subscription exists.
    fakeRow = { tier: 'free', enterpriseEntitled: true, demoEnterprise: false };
    expect(await accountHasEntitlement('acct', 'sso')).toBe(true);
    expect((await getAccountEntitlements('acct')).scim).toBe(true);
  });

  test('flag off → falls back to tier gating (per_seat is fully gated)', async () => {
    fakeRow = { tier: 'per_seat', enterpriseEntitled: false, demoEnterprise: false };
    expect(await accountHasEntitlement('acct', 'sso')).toBe(false);
    expect((await getAccountEntitlements('acct')).sso).toBe(false);
    expect((await getAccountEntitlements('acct')).scim).toBe(false);
  });

  test('no billing row → fail closed', async () => {
    fakeRow = null;
    expect(await accountHasEntitlement('acct', 'sso')).toBe(false);
    expect((await getAccountEntitlements('acct')).scim).toBe(false);
  });

  test('genuine enterprise tier still unlocks without the flag', async () => {
    // The legacy sales-assigned path (tier='enterprise') is untouched.
    fakeRow = { tier: 'enterprise', enterpriseEntitled: false, demoEnterprise: false };
    expect(await accountHasEntitlement('acct', 'sso')).toBe(true);
    expect((await getAccountEntitlements('acct')).scim).toBe(true);
  });

  test('flag on + demo on → still unlocked (flag is a superset; no conflict)', async () => {
    fakeRow = { tier: 'per_seat', enterpriseEntitled: true, demoEnterprise: true };
    expect(await accountHasEntitlement('acct', 'sso')).toBe(true);
    expect((await getAccountEntitlements('acct')).auditAccess).toBe(true);
  });

  test('flag on + tier=enterprise → still unlocked (both sources agree)', async () => {
    fakeRow = { tier: 'enterprise', enterpriseEntitled: true, demoEnterprise: false };
    expect(await accountHasEntitlement('acct', 'rbac')).toBe(true);
  });
});

// Resolution order: ENTERPRISE_LICENSE_AVAILABLE takes precedence over the
// per-account flag (a licensed self-host operator never needs to also flip the
// per-account flag), which in turn takes precedence over demo_enterprise, which
// takes precedence over the billing tier.
describe('enterprise_entitled resolution order vs license / demo / tier', () => {
  afterEach(() => {
    enterpriseLicenseAvailable = false;
  });

  test('license on → unlocked even when enterprise_entitled is false', async () => {
    enterpriseLicenseAvailable = true;
    fakeRow = { tier: 'per_seat', enterpriseEntitled: false, demoEnterprise: false };
    expect(await accountHasEntitlement('acct', 'sso')).toBe(true);
  });

  test('license on → unlocked even with no billing row', async () => {
    enterpriseLicenseAvailable = true;
    fakeRow = null;
    const ent = await getAccountEntitlements('acct');
    expect(ent).toEqual({ sso: true, scim: true, rbac: true, auditAccess: true });
  });

  test('license off, flag on, demo off, tier per_seat → flag wins (entitlements on)', async () => {
    enterpriseLicenseAvailable = false;
    fakeRow = { tier: 'per_seat', enterpriseEntitled: true, demoEnterprise: false };
    expect(await accountHasEntitlement('acct', 'sso')).toBe(true);
  });

  test('license off, flag off, demo on → demo wins (entitlements on)', async () => {
    enterpriseLicenseAvailable = false;
    fakeRow = { tier: 'per_seat', enterpriseEntitled: false, demoEnterprise: true };
    expect(await accountHasEntitlement('acct', 'sso')).toBe(true);
  });

  test('license off, flag off, demo off, tier per_seat → all gated (the bug shape, fixed)', async () => {
    enterpriseLicenseAvailable = false;
    fakeRow = { tier: 'per_seat', enterpriseEntitled: false, demoEnterprise: false };
    expect(await accountHasEntitlement('acct', 'sso')).toBe(false);
    expect(await accountHasEntitlement('acct', 'scim')).toBe(false);
    expect(await accountHasEntitlement('acct', 'rbac')).toBe(false);
    expect(await accountHasEntitlement('acct', 'auditAccess')).toBe(false);
  });
});
