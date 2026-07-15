import { afterEach, describe, expect, mock, test } from 'bun:test';

// Stub the credit-account repo before loading the resolver, so we exercise the
// demo-override branch without a database. `fakeRow` stands in for the row that
// getCreditAccount() would return.
let fakeRow: { tier?: string; demoEnterprise?: boolean } | null = null;
mock.module('../billing/repositories/credit-accounts', () => ({
  getCreditAccount: async () => fakeRow,
}));

// Self-host ENTERPRISE_LICENSE_AVAILABLE bypass — a getter so each test can
// flip it without re-mocking the module. Everything else entitlements.ts
// might read from config stays absent; it only ever touches this one field.
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

// The self-serve enterprise-demo flag must unlock the ENTIRE enterprise surface
// regardless of billing tier, stay fail-closed when off / unprovisioned, and
// never suppress a genuine enterprise tier. These invariants ARE the demo's
// access-control contract (the IAM guards call accountHasEntitlement).
describe('enterprise-demo entitlement override', () => {
  test('demo on → every entitlement unlocked even on the free tier', async () => {
    fakeRow = { tier: 'free', demoEnterprise: true };
    expect(await accountHasEntitlement('acct', 'sso')).toBe(true);
    expect(await accountHasEntitlement('acct', 'scim')).toBe(true);
    const ent = await getAccountEntitlements('acct');
    expect(ent.sso).toBe(true);
    expect(ent.scim).toBe(true);
  });

  test('demo off → falls back to tier gating (free is fully gated)', async () => {
    fakeRow = { tier: 'free', demoEnterprise: false };
    expect(await accountHasEntitlement('acct', 'sso')).toBe(false);
    expect((await getAccountEntitlements('acct')).sso).toBe(false);
  });

  test('no billing row → fail closed', async () => {
    fakeRow = null;
    expect(await accountHasEntitlement('acct', 'sso')).toBe(false);
    expect((await getAccountEntitlements('acct')).scim).toBe(false);
  });

  test('genuine enterprise tier still unlocks without the demo flag', async () => {
    fakeRow = { tier: 'enterprise', demoEnterprise: false };
    expect(await accountHasEntitlement('acct', 'sso')).toBe(true);
    expect((await getAccountEntitlements('acct')).scim).toBe(true);
  });
});

// Self-host ENTERPRISE_LICENSE_AVAILABLE: an operator-level license bypass
// (config, not a per-account flag) that must unlock every entitlement
// regardless of the account's billing tier — self-host accounts never carry
// a real 'enterprise' tier, since there's no Stripe subscription to assign it.
describe('self-host ENTERPRISE_LICENSE_AVAILABLE override', () => {
  afterEach(() => {
    enterpriseLicenseAvailable = false;
  });

  test('license on → unlocked even with no billing row at all', async () => {
    enterpriseLicenseAvailable = true;
    fakeRow = null;
    expect(await accountHasEntitlement('acct', 'sso')).toBe(true);
    expect(await accountHasEntitlement('acct', 'scim')).toBe(true);
    const ent = await getAccountEntitlements('acct');
    expect(ent.sso).toBe(true);
    expect(ent.scim).toBe(true);
    expect(ent.rbac).toBe(true);
    expect(ent.auditAccess).toBe(true);
  });

  test('license on → unlocked even on the free tier', async () => {
    enterpriseLicenseAvailable = true;
    fakeRow = { tier: 'free', demoEnterprise: false };
    expect(await accountHasEntitlement('acct', 'sso')).toBe(true);
    expect((await getAccountEntitlements('acct')).scim).toBe(true);
  });

  test('license off → falls back to normal tier gating', async () => {
    enterpriseLicenseAvailable = false;
    fakeRow = { tier: 'free', demoEnterprise: false };
    expect(await accountHasEntitlement('acct', 'sso')).toBe(false);
    expect((await getAccountEntitlements('acct')).sso).toBe(false);
  });
});
