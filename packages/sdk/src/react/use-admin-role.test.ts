import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Same harness as `./use-admin-projects.test.ts`: `useQuery` returns its config,
// `backendApi` records the request.

let calls: string[] = [];
let nextData: unknown = { isAdmin: true, role: 'admin' };

mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
}));
mock.module('../core/http/api-client', () => ({
  backendApi: {
    get: async (path: string) => {
      calls.push(path);
      return { data: nextData, error: null };
    },
  },
}));

const { useAdminRole, ADMIN_ROLE_QUERY_KEY } = await import('./use-admin-role');

beforeEach(() => {
  calls = [];
  nextData = { isAdmin: true, role: 'admin' };
});

describe('useAdminRole', () => {
  test('is keyed by user and disabled without one', () => {
    const signedOut = useAdminRole(null) as any;
    expect(signedOut.queryKey).toEqual([ADMIN_ROLE_QUERY_KEY, null]);
    expect(signedOut.enabled).toBe(false);
    const signedIn = useAdminRole('u1') as any;
    expect(signedIn.queryKey).toEqual([ADMIN_ROLE_QUERY_KEY, 'u1']);
    expect(signedIn.enabled).toBe(true);
  });

  test('answers not-admin without a request when signed out, else reads /user-roles', async () => {
    expect(await (useAdminRole(null) as any).queryFn()).toEqual({ isAdmin: false, role: null });
    expect(calls).toEqual([]);
    expect(await (useAdminRole('u1') as any).queryFn()).toEqual({ isAdmin: true, role: 'admin' });
    expect(calls).toEqual(['/user-roles']);
  });

  test('refetches on mount and focus so a revoked role propagates', () => {
    const hook = useAdminRole('u1') as any;
    expect(hook.refetchOnMount).toBe(true);
    expect(hook.refetchOnWindowFocus).toBe(true);
    expect(hook.staleTime).toBe(30_000);
  });

  test('the caller can disable it', () => {
    expect((useAdminRole('u1', { enabled: false }) as any).enabled).toBe(false);
  });
});
