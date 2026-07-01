import { describe, expect, mock, test } from 'bun:test';

// Stub the credit-account repo before loading the resolver, so we exercise the
// demo-override branch without a database. `fakeRow` stands in for the row that
// getCreditAccount() would return.
let fakeRow: { tier?: string; demoEnterprise?: boolean } | null = null;
mock.module('../billing/repositories/credit-accounts', () => ({
  getCreditAccount: async () => fakeRow,
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
