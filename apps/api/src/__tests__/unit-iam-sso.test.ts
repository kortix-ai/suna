import { beforeEach, describe, expect, mock, test } from 'bun:test';

const state = {
  providerLookups: [] as string[],
  groupMappingLookups: [] as string[],
  provider: null as null | {
    accountId: string;
    autoCreateMembers: boolean;
    groupClaimName: string;
  },
  mappings: [] as Array<{ claimValue: string; groupId: string }>,
  memberRows: [] as Array<{ userId: string }>,
  currentGroupRows: [] as Array<{ groupId: string }>,
  inserts: [] as Array<{ table: string; values: unknown }>,
  deletes: [] as Array<{ table: string; condition: unknown }>,
};

function rowsForSelect(shape: Record<string, unknown>) {
  if ('groupId' in shape) return state.currentGroupRows;
  return state.memberRows;
}

const fakeDb = {
  select: (shape: Record<string, unknown>) => ({
    from: () => ({
      where: () => {
        const rows = rowsForSelect(shape);
        return {
          limit: async (count: number) => rows.slice(0, count),
          then: (resolve: (value: unknown) => unknown, reject: (reason?: unknown) => unknown) =>
            Promise.resolve(rows).then(resolve, reject),
        };
      },
    }),
  }),
  insert: () => ({
    values: (values: unknown) => {
      state.inserts.push({ table: tableNameForValues(values), values });
      return { onConflictDoNothing: async () => undefined };
    },
  }),
  delete: () => ({
    where: async (condition: unknown) => {
      state.deletes.push({ table: 'accountGroupMembers', condition });
    },
  }),
};

mock.module('../shared/db', () => ({ db: fakeDb }));

mock.module('../repositories/sso', () => ({
  getSsoProviderBySupabaseId: async (providerId: string) => {
    state.providerLookups.push(providerId);
    return state.provider;
  },
  listSsoGroupMappings: async (accountId: string) => {
    state.groupMappingLookups.push(accountId);
    return state.mappings;
  },
}));

const { syncSsoMembership } = await import('../iam/sso-sync');

beforeEach(() => {
  state.providerLookups = [];
  state.groupMappingLookups = [];
  state.provider = null;
  state.mappings = [];
  state.memberRows = [];
  state.currentGroupRows = [];
  state.inserts = [];
  state.deletes = [];
});

describe('syncSsoMembership', () => {
  test('skips cheaply when the JWT has no valid Supabase SSO provider id', async () => {
    expect(await syncSsoMembership(baseArgs({}))).toEqual({ skipped: true });
    expect(await syncSsoMembership(baseArgs(undefined))).toEqual({ skipped: true });
    expect(await syncSsoMembership(baseArgs({ app_metadata: { sso_provider_id: 123 } }))).toEqual({ skipped: true });
    expect(state.providerLookups).toEqual([]);
  });

  test('accepts both current and legacy Supabase provider-id claims', async () => {
    state.provider = provider();

    await syncSsoMembership(baseArgs({ app_metadata: { sso_provider_id: 'sso-current' } }));
    await syncSsoMembership(baseArgs({ app_metadata: { provider_id: 'sso-legacy' } }));

    expect(state.providerLookups).toEqual(['sso-current', 'sso-legacy']);
  });

  test('auto-creates account membership when the mapped provider allows JIT members', async () => {
    state.provider = provider({ autoCreateMembers: true });

    const result = await syncSsoMembership(baseArgs({ app_metadata: { sso_provider_id: 'sso-1' } }));

    expect(result).toEqual({ skipped: false, memberCreated: true });
    expect(state.inserts).toEqual([
      {
        table: 'accountMembers',
        values: { accountId: 'acct-1', userId: 'user-1', accountRole: 'member' },
      },
    ]);
  });

  test('does not JIT-create account membership when provider auto-create is disabled', async () => {
    state.provider = provider({ autoCreateMembers: false });

    const result = await syncSsoMembership(baseArgs({ app_metadata: { sso_provider_id: 'sso-1' } }));

    expect(result).toEqual({ skipped: false, memberCreated: false });
    expect(state.inserts).toEqual([]);
    expect(state.groupMappingLookups).toEqual([]);
  });

  test('syncs mapped groups from app_metadata claims and removes stale SSO-owned groups', async () => {
    state.provider = provider({ groupClaimName: 'groups' });
    state.memberRows = [{ userId: 'user-1' }];
    state.mappings = [
      { claimValue: 'Engineers', groupId: 'g-engineers' },
      { claimValue: 'Admins', groupId: 'g-admins' },
      { claimValue: 'Sales', groupId: 'g-sales' },
    ];
    state.currentGroupRows = [{ groupId: 'g-admins' }, { groupId: 'g-sales' }];

    const result = await syncSsoMembership(baseArgs({
      app_metadata: {
        sso_provider_id: 'sso-1',
        groups: ['Engineers', 'Admins', 42, null],
      },
    }));

    expect(result).toEqual({
      skipped: false,
      memberCreated: false,
      groupsAdded: ['g-engineers'],
      groupsRemoved: ['g-sales'],
    });
    expect(state.inserts).toEqual([
      { table: 'accountGroupMembers', values: [{ groupId: 'g-engineers', userId: 'user-1', addedBy: null }] },
    ]);
    expect(state.deletes).toHaveLength(1);
  });

  test('reads group claims from user_metadata and top-level JWT fields', async () => {
    state.provider = provider({ groupClaimName: 'roles' });
    state.memberRows = [{ userId: 'user-1' }];
    state.mappings = [{ claimValue: 'admin', groupId: 'g-admin' }];

    expect(await syncSsoMembership(baseArgs({
      app_metadata: { sso_provider_id: 'sso-1' },
      user_metadata: { roles: ['admin'] },
    }))).toMatchObject({ groupsAdded: ['g-admin'] });

    state.inserts = [];
    state.provider = provider({ groupClaimName: 'memberOf' });
    state.mappings = [{ claimValue: 'everyone', groupId: 'g-everyone' }];

    expect(await syncSsoMembership(baseArgs({
      app_metadata: { sso_provider_id: 'sso-1' },
      memberOf: 'everyone',
    }))).toMatchObject({ groupsAdded: ['g-everyone'] });
  });

  test('preserves manually-added groups that are not SSO mapped', async () => {
    state.provider = provider();
    state.memberRows = [{ userId: 'user-1' }];
    state.mappings = [{ claimValue: 'Engineers', groupId: 'g-engineers' }];
    state.currentGroupRows = [{ groupId: 'manual-group' }, { groupId: 'g-engineers' }];

    const result = await syncSsoMembership(baseArgs({ app_metadata: { sso_provider_id: 'sso-1' } }));

    expect(result).toMatchObject({ groupsAdded: [], groupsRemoved: ['g-engineers'] });
    expect(result.groupsRemoved).not.toContain('manual-group');
  });
});

function baseArgs(jwtPayload: Record<string, unknown> | undefined) {
  return {
    userId: 'user-1',
    email: 'user@example.com',
    jwtPayload,
  };
}

function provider(overrides: Partial<typeof state.provider> = {}) {
  return {
    accountId: 'acct-1',
    autoCreateMembers: true,
    groupClaimName: 'groups',
    ...overrides,
  };
}

function tableNameForValues(values: unknown) {
  if (Array.isArray(values)) return 'accountGroupMembers';
  if (values && typeof values === 'object' && 'accountRole' in values) return 'accountMembers';
  return 'unknown';
}
