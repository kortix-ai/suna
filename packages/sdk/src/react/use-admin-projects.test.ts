import { describe, expect, test, beforeEach, mock } from 'bun:test';

// Same harness as `./use-admin-accounts.test.ts`: react-query's `useQuery` is
// mocked down to an identity function (returns the config object) so the hook
// can be called as a plain function — no React render tree — while still
// exercising the exact `queryFn` request and `queryKey` it builds. `backendApi`
// is mocked too, so `queryFn` is asserted against the recorded path instead of
// hitting the network.

type Call = { method: string; path: string };
let calls: Call[] = [];
let nextError: { message: string } | null = null;
let nextData: unknown = { projects: [], total: 0, page: 1, limit: 50 };

mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
  useMutation: (config: Record<string, unknown>) => config,
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}));

mock.module('../core/http/api-client', () => ({
  backendApi: {
    get: async (path: string) => {
      calls.push({ method: 'GET', path });
      return { data: nextData, error: nextError };
    },
  },
}));

const { useAdminProjects } = await import('./use-admin-projects');

beforeEach(() => {
  calls = [];
  nextError = null;
  nextData = { projects: [], total: 0, page: 1, limit: 50 };
});

/** The query string of the single request the hook made. */
function requestedQuery(): URLSearchParams {
  expect(calls).toHaveLength(1);
  return new URLSearchParams(calls[0]!.path.split('?')[1] ?? '');
}

describe('useAdminProjects', () => {
  test('defaults to the most-active-first fleet view', async () => {
    const hook = useAdminProjects() as any;
    await hook.queryFn();
    const q = requestedQuery();
    expect(calls[0]!.path.startsWith('/admin/api/projects?')).toBe(true);
    expect(q.get('sortBy')).toBe('activity');
    expect(q.get('sortDir')).toBe('desc');
    expect(q.get('page')).toBe('1');
    expect(q.get('limit')).toBe('50');
  });

  test('omits every filter that is unset — no empty search/accountId/status', async () => {
    const hook = useAdminProjects() as any;
    await hook.queryFn();
    const q = requestedQuery();
    expect(q.has('search')).toBe(false);
    expect(q.has('accountId')).toBe(false);
    expect(q.has('status')).toBe(false);
  });

  test('sends search, accountId, status (csv), sort and pagination', async () => {
    const hook = useAdminProjects({
      search: 'acme',
      accountId: 'acct-1',
      status: ['active', 'archived'],
      sortBy: 'sessions',
      sortDir: 'asc',
      page: 3,
      limit: 25,
    }) as any;
    await hook.queryFn();
    const q = requestedQuery();
    expect(q.get('search')).toBe('acme');
    expect(q.get('accountId')).toBe('acct-1');
    expect(q.get('status')).toBe('active,archived');
    expect(q.get('sortBy')).toBe('sessions');
    expect(q.get('sortDir')).toBe('asc');
    expect(q.get('page')).toBe('3');
    expect(q.get('limit')).toBe('25');
  });

  // The key must carry every input, or two different filter sets share one
  // cache entry and the table renders the previous query's rows.
  test('the query key carries every filter input', () => {
    const hook = useAdminProjects({
      search: 'acme',
      accountId: 'acct-1',
      status: ['active'],
      sortBy: 'created',
      sortDir: 'asc',
      page: 2,
      limit: 10,
    }) as any;
    expect(hook.queryKey).toEqual([
      'admin',
      'projects',
      'acme',
      'acct-1',
      'active',
      'created',
      'asc',
      2,
      10,
    ]);
  });

  test('different filters produce different query keys', () => {
    const a = useAdminProjects({ sortBy: 'activity' }) as any;
    const b = useAdminProjects({ sortBy: 'sessions' }) as any;
    expect(a.queryKey).not.toEqual(b.queryKey);
  });

  test('returns the page body on success', async () => {
    nextData = {
      projects: [
        {
          projectId: 'p1',
          name: 'demo',
          status: 'active',
          accountId: 'a1',
          accountName: 'Acme',
          ownerEmail: 'owner@acme.test',
          createdAt: '2026-08-01T00:00:00.000Z',
          sessionCount: 4,
          activeSessionCount: 1,
          lastSessionAt: '2026-08-06T00:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      limit: 50,
    };
    const hook = useAdminProjects() as any;
    await expect(hook.queryFn()).resolves.toEqual(nextData);
  });

  test('throws the API error message instead of returning it', async () => {
    nextError = { message: 'admin_required' };
    const hook = useAdminProjects() as any;
    await expect(hook.queryFn()).rejects.toThrow('admin_required');
  });

  test('keeps the previous page rendered while the next one loads', () => {
    const hook = useAdminProjects() as any;
    expect(hook.placeholderData({ total: 7 })).toEqual({ total: 7 });
  });
});
