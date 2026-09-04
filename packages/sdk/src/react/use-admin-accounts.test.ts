import { describe, expect, test } from 'bun:test';
import {
  ADMIN_OVERRIDE_KEYS,
  adminAccountLookupPath,
  adminAccountOverridesPath,
  adminAccountSubscriptionPath,
  adminMemberRolePath,
  useAdminAccount,
  useAdminAccountSubscription,
  useAdminSetMemberRole,
  useAdminSetOverrides,
  type AdminAccount,
  type AdminAccountMemberRole,
  type AdminAccountSubscription,
  type AdminEntitlementOverridePatch,
  type AdminEntitlementOverrides,
} from './use-admin-accounts';

describe('admin single-account lookup contract', () => {
  // The sheet's live row: an exact-id query against the list route, immune to
  // whatever filters the list currently has. Pins the wire shape.
  test('adminAccountLookupPath queries the list route by exact accountId', () => {
    expect(adminAccountLookupPath('acct_1')).toBe('/admin/api/accounts?accountId=acct_1&limit=1');
  });

  test('useAdminAccount is exported as a hook', () => {
    expect(typeof useAdminAccount).toBe('function');
  });
});

describe('admin member-role mutation contract', () => {
  // The server route is /admin/api/accounts/{id}/members/{userId}/role — the
  // path builder is the single place the hook derives it from, so this test
  // pins the wire contract without needing a rendered hook.
  test('adminMemberRolePath targets the platform-admin role route', () => {
    expect(adminMemberRolePath('acct_1', 'user_9')).toBe(
      '/admin/api/accounts/acct_1/members/user_9/role',
    );
  });

  test('useAdminSetMemberRole is exported as a hook', () => {
    expect(typeof useAdminSetMemberRole).toBe('function');
  });

  test('role union covers exactly the three account roles', () => {
    const roles: AdminAccountMemberRole[] = ['owner', 'admin', 'member'];
    expect(roles).toHaveLength(3);
  });
});

describe('admin live-Stripe-subscription read', () => {
  // What Stripe ACTUALLY charges, shown next to the resolved plan badge. A
  // stored 'pro' tier renders "Team · $20/mo · grandfathered" while the real
  // subscription can be a $40/mo legacy machine sub — the sheet needs both.
  test('adminAccountSubscriptionPath targets the admin subscription route', () => {
    expect(adminAccountSubscriptionPath('acct_1')).toBe('/admin/api/accounts/acct_1/subscription');
  });

  test('useAdminAccountSubscription is exported as a hook', () => {
    expect(typeof useAdminAccountSubscription).toBe('function');
  });

  test('AdminAccountSubscription pins the wire shape the sheet renders', () => {
    const sub: AdminAccountSubscription = {
      id: 'sub_1TIWcF',
      status: 'active',
      description: 'Kortix Computer · Pro — 8 vCPU, 16 GB RAM, 320 GB SSD',
      productName: 'Kortix Computer',
      priceId: 'price_1',
      unitAmountUsd: 40,
      quantity: 1,
      totalAmountUsd: 40,
      interval: 'month',
      currency: 'usd',
      currentPeriodEnd: '2026-09-04T00:00:00.000Z',
      cancelAtPeriodEnd: false,
    };
    expect(sub.totalAmountUsd).toBe(40);
  });
});

describe('admin accounts list — display name', () => {
  // The name the PRODUCT shows. The raw stored `name` is a migration
  // placeholder ('Personal'/'User') for old rows; the server maps it to
  // "<owner email>'s Account" and the console renders that same truth.
  // Optional so a console pointed at an older API still type-checks.
  test('AdminAccount carries displayName, and it is optional', () => {
    const row: Pick<AdminAccount, 'name' | 'displayName'> = {
      name: 'Personal',
      displayName: "sc@wring.co's Account",
    };
    expect(row.displayName).toBe("sc@wring.co's Account");
    const older: Pick<AdminAccount, 'name' | 'displayName'> = { name: 'Personal' };
    expect(older.displayName).toBeUndefined();
  });
});

describe('admin accounts list — resolved plan block', () => {
  // The console must never re-derive a plan label from the raw tier key: that
  // is how "· legacy" got hand-maintained in the page and drifted from the
  // server. The list route now ships the resolved plan; this pins its shape,
  // and that it stays OPTIONAL so a console pointed at an older API still
  // type-checks (and falls back at runtime).
  test('AdminAccount carries the resolved plan, and it is optional', () => {
    const grandfathered: Pick<AdminAccount, 'plan'> = {
      plan: {
        key: 'per_seat',
        family: 'team',
        label: 'Team',
        sublabel: '$40/seat/mo · grandfathered',
        status: 'grandfathered',
        is_grandfathered: true,
      },
    };
    const olderApi: Pick<AdminAccount, 'plan'> = {};

    expect(grandfathered.plan?.label).toBe('Team');
    expect(grandfathered.plan?.sublabel).toContain('grandfathered');
    expect(olderApi.plan).toBeUndefined();
  });
});

describe('admin entitlement-override mutation contract', () => {
  // PUT /admin/api/accounts/{id}/overrides is the ONE route behind every
  // override the console can set, so the path builder is the single place the
  // hook derives the wire contract from.
  test('adminAccountOverridesPath targets the merge-patch route', () => {
    expect(adminAccountOverridesPath('acct_1')).toBe('/admin/api/accounts/acct_1/overrides');
  });

  test('adminAccountOverridesPath encodes an id that needs it', () => {
    expect(adminAccountOverridesPath('acct 1/2')).toBe('/admin/api/accounts/acct%201%2F2/overrides');
  });

  test('useAdminSetOverrides is exported as a hook', () => {
    expect(typeof useAdminSetOverrides).toBe('function');
  });

  // The eleven keys the server's `validateOverridePatch` accepts — an unknown key
  // is a 400, so the console must not be able to invent one.
  test('ADMIN_OVERRIDE_KEYS is exactly the server-side override catalog', () => {
    expect([...ADMIN_OVERRIDE_KEYS]).toEqual([
      'enterpriseEntitled',
      'demoEnterprise',
      'managedModelsOverride',
      'maxConcurrentSessions',
      'computeRateMultiplier',
      'sso',
      'scim',
      'rbac',
      'auditAccess',
      'branding',
      'managedModels',
    ]);
  });

  // Merge-patch (RFC 7386): an entry sets, `null` deletes, an absent key is
  // left alone. The type must permit `null` or a form that only knows one
  // field cannot delete it.
  test('a patch accepts an entry, an expiring entry, and null to delete', () => {
    const patch: AdminEntitlementOverridePatch = {
      computeRateMultiplier: { value: 0.5 },
      sso: { value: true, expires_at: '2026-09-01T00:00:00.000Z' },
      managedModels: null,
    };

    expect(patch.computeRateMultiplier).toEqual({ value: 0.5 });
    expect(patch.sso?.expires_at).toBe('2026-09-01T00:00:00.000Z');
    expect(patch.managedModels).toBeNull();
  });
});

describe('admin accounts list — stored entitlement overrides', () => {
  // The row carries the STORED map (expiry not applied), which is what an
  // operator must see — including a lapsed entry — plus the RESOLVED compute
  // multiplier the meter actually bills at. Both stay optional so a console
  // pointed at an older API still type-checks.
  test('AdminAccount carries the stored override map and it is optional', () => {
    const overridden: Pick<AdminAccount, 'entitlementOverrides' | 'computeRateMultiplier'> = {
      entitlementOverrides: {
        computeRateMultiplier: { value: 0.5 },
        sso: { value: true, expires_at: '2026-09-01T00:00:00.000Z' },
      },
      computeRateMultiplier: 0.5,
    };
    const olderApi: Pick<AdminAccount, 'entitlementOverrides' | 'computeRateMultiplier'> = {};

    expect(overridden.entitlementOverrides?.computeRateMultiplier?.value).toBe(0.5);
    expect(overridden.entitlementOverrides?.sso?.expires_at).toBe('2026-09-01T00:00:00.000Z');
    expect(overridden.computeRateMultiplier).toBe(0.5);
    expect(olderApi.entitlementOverrides).toBeUndefined();
  });

  // JSONB written by admin routes, migrations, and operator SQL: the value is
  // `unknown` on purpose, so every reader narrows before it renders.
  test('an override entry value is unknown until narrowed', () => {
    const stored: AdminEntitlementOverrides = { maxConcurrentSessions: { value: 12 } };
    const raw: unknown = stored.maxConcurrentSessions?.value;

    expect(typeof raw === 'number' ? raw : null).toBe(12);
  });
});
