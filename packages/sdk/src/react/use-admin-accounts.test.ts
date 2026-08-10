import { describe, expect, test, beforeEach, mock } from 'bun:test';

// Same harness as `./use-project-secrets.test.ts`: react-query's `useMutation`
// is mocked down to an identity function (returns the config object) so each
// hook can be called as a plain function — no React render tree — while still
// exercising the exact `mutationFn` request and `onSuccess` invalidation the
// real hook builds. `backendApi` is mocked too, so `mutationFn` is asserted
// against the recorded method/path/body instead of hitting the network.

let invalidated: unknown[][] = [];
mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
  useMutation: (config: Record<string, unknown>) => config,
  useQueryClient: () => ({
    invalidateQueries: (opts: { queryKey: unknown[] }) => {
      invalidated.push(opts.queryKey);
    },
  }),
}));

type Call = { method: string; path: string; body?: unknown };
let calls: Call[] = [];
let nextError: { message: string } | null = null;

mock.module('../core/http/api-client', () => ({
  backendApi: {
    get: async (path: string) => {
      calls.push({ method: 'GET', path });
      return { data: { ok: true }, error: nextError };
    },
    post: async (path: string, body?: unknown) => {
      calls.push({ method: 'POST', path, body });
      return { data: { ok: true }, error: nextError };
    },
    delete: async (path: string) => {
      calls.push({ method: 'DELETE', path });
      return { data: { ok: true }, error: nextError };
    },
  },
}));

const {
  useAdminGrantTrial,
  useAdminRevokeTrial,
  useAdminSetManagedModels,
  useAdminSetEnterpriseDemo,
  useAdminSetEnterpriseEntitled,
  useAdminAccountWorkspaces,
  useAdminAccountProjects,
} = await import('./use-admin-accounts');

beforeEach(() => {
  invalidated = [];
  calls = [];
  nextError = null;
});

const ACCOUNT = 'acct-1';

describe('admin account Workspace inventory compatibility', () => {
  test('canonical hook calls the Workspace route and uses a Workspace query key', async () => {
    const hook = useAdminAccountWorkspaces(ACCOUNT) as any;
    expect(hook.queryKey).toEqual(['admin', 'accounts', ACCOUNT, 'workspaces']);
    await hook.queryFn();
    expect(calls).toEqual([
      { method: 'GET', path: `/admin/api/accounts/${ACCOUNT}/workspaces` },
    ]);
  });

  test('deprecated Project hook retains its exact route and query key', async () => {
    const hook = useAdminAccountProjects(ACCOUNT) as any;
    expect(hook.queryKey).toEqual(['admin', 'accounts', ACCOUNT, 'projects']);
    await hook.queryFn();
    expect(calls).toEqual([
      { method: 'GET', path: `/admin/api/accounts/${ACCOUNT}/projects` },
    ]);
  });
});

describe('useAdminGrantTrial', () => {
  test('POSTs the snake_case trial body the admin route validates', async () => {
    const hook = useAdminGrantTrial() as any;
    await hook.mutationFn({
      accountId: ACCOUNT,
      tierKey: 'team',
      seats: 5,
      durationDays: 30,
      creditGrant: 25,
      note: 'pilot',
    });
    expect(calls).toEqual([
      {
        method: 'POST',
        path: `/admin/api/accounts/${ACCOUNT}/trial`,
        body: { tier_key: 'team', seats: 5, duration_days: 30, credit_grant: 25, note: 'pilot' },
      },
    ]);
  });

  test('omits optional note and credit_grant when not supplied', async () => {
    const hook = useAdminGrantTrial() as any;
    await hook.mutationFn({ accountId: ACCOUNT, tierKey: 'pro', seats: 1, durationDays: 14 });
    expect(calls[0]!.body).toEqual({ tier_key: 'pro', seats: 1, duration_days: 14 });
  });

  test('throws the API error message instead of returning it', async () => {
    nextError = { message: 'tier_key must be an existing paid tier, got "free"' };
    const hook = useAdminGrantTrial() as any;
    await expect(
      hook.mutationFn({ accountId: ACCOUNT, tierKey: 'free', seats: 1, durationDays: 14 }),
    ).rejects.toThrow('tier_key must be an existing paid tier, got "free"');
  });

  test('invalidates the accounts list and the account detail on success', () => {
    const hook = useAdminGrantTrial() as any;
    hook.onSuccess({}, { accountId: ACCOUNT });
    expect(invalidated).toEqual([
      ['admin', 'accounts'],
      ['admin', 'accounts', ACCOUNT],
    ]);
  });
});

describe('useAdminRevokeTrial', () => {
  test('DELETEs the trial route', async () => {
    const hook = useAdminRevokeTrial() as any;
    await hook.mutationFn({ accountId: ACCOUNT });
    expect(calls).toEqual([{ method: 'DELETE', path: `/admin/api/accounts/${ACCOUNT}/trial` }]);
  });

  test('throws the API error message (400 when no trial is active)', async () => {
    nextError = { message: 'no active trial to revoke (status: none)' };
    const hook = useAdminRevokeTrial() as any;
    await expect(hook.mutationFn({ accountId: ACCOUNT })).rejects.toThrow(
      'no active trial to revoke (status: none)',
    );
  });

  test('invalidates the accounts list and the account detail on success', () => {
    const hook = useAdminRevokeTrial() as any;
    hook.onSuccess({}, { accountId: ACCOUNT });
    expect(invalidated).toEqual([
      ['admin', 'accounts'],
      ['admin', 'accounts', ACCOUNT],
    ]);
  });
});

describe('useAdminSetManagedModels', () => {
  test('sends all three override states, null included', async () => {
    const hook = useAdminSetManagedModels() as any;
    await hook.mutationFn({ accountId: ACCOUNT, override: true });
    await hook.mutationFn({ accountId: ACCOUNT, override: false });
    await hook.mutationFn({ accountId: ACCOUNT, override: null });
    expect(calls.map((c) => c.body)).toEqual([
      { override: true },
      { override: false },
      { override: null },
    ]);
    expect(calls[0]!.path).toBe(`/admin/api/accounts/${ACCOUNT}/managed-models`);
  });

  test('invalidates the accounts list and the account detail on success', () => {
    const hook = useAdminSetManagedModels() as any;
    hook.onSuccess({}, { accountId: ACCOUNT });
    expect(invalidated).toEqual([
      ['admin', 'accounts'],
      ['admin', 'accounts', ACCOUNT],
    ]);
  });
});

describe('useAdminSetEnterpriseDemo', () => {
  test('POSTs {enabled} to the enterprise-demo route', async () => {
    const hook = useAdminSetEnterpriseDemo() as any;
    await hook.mutationFn({ accountId: ACCOUNT, enabled: true });
    expect(calls).toEqual([
      {
        method: 'POST',
        path: `/admin/api/accounts/${ACCOUNT}/enterprise-demo`,
        body: { enabled: true },
      },
    ]);
  });

  test('invalidates the accounts list and the account detail on success', () => {
    const hook = useAdminSetEnterpriseDemo() as any;
    hook.onSuccess({}, { accountId: ACCOUNT });
    expect(invalidated).toEqual([
      ['admin', 'accounts'],
      ['admin', 'accounts', ACCOUNT],
    ]);
  });
});

describe('useAdminSetEnterpriseEntitled', () => {
  test('POSTs {enabled} to the enterprise-entitlement route', async () => {
    const hook = useAdminSetEnterpriseEntitled() as any;
    await hook.mutationFn({ accountId: ACCOUNT, enabled: false });
    expect(calls).toEqual([
      {
        method: 'POST',
        path: `/admin/api/accounts/${ACCOUNT}/enterprise-entitlement`,
        body: { enabled: false },
      },
    ]);
  });

  test('invalidates the accounts list and the account detail on success', () => {
    const hook = useAdminSetEnterpriseEntitled() as any;
    hook.onSuccess({}, { accountId: ACCOUNT });
    expect(invalidated).toEqual([
      ['admin', 'accounts'],
      ['admin', 'accounts', ACCOUNT],
    ]);
  });
});
