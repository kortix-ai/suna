import { describe, expect, test, beforeEach, mock } from 'bun:test';

// Same harness as `./use-admin-accounts.test.ts` / `./use-project-secrets.test.ts`:
// react-query's `useQuery` is mocked down to an identity function so each hook
// returns its own config object and can be exercised as a plain function — no
// React render tree — while still asserting the exact `queryKey`, `queryFn`
// request and freshness options the real hook builds. `backendApi` is mocked so
// `queryFn` is checked against the recorded method/path instead of the network.

type Call = { method: string; path: string };
let calls: Call[] = [];
let nextError: { message: string } | null = null;
let nextData: unknown = { days: [], summary: {} };

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

const {
  useAdminActivityAnalytics,
  useAdminUsageAnalytics,
  clampAdminAnalyticsDays,
  ADMIN_ANALYTICS_DEFAULT_DAYS,
  ADMIN_ANALYTICS_MAX_DAYS,
  ADMIN_ANALYTICS_MIN_DAYS,
} = await import('./use-admin-activity-analytics');

beforeEach(() => {
  calls = [];
  nextError = null;
  nextData = { days: [], summary: {} };
});

describe('clampAdminAnalyticsDays', () => {
  test('defaults when the value is missing or not a finite number', () => {
    expect(clampAdminAnalyticsDays(undefined)).toBe(ADMIN_ANALYTICS_DEFAULT_DAYS);
    expect(clampAdminAnalyticsDays(Number.NaN)).toBe(ADMIN_ANALYTICS_DEFAULT_DAYS);
    expect(clampAdminAnalyticsDays(Number.POSITIVE_INFINITY)).toBe(ADMIN_ANALYTICS_DEFAULT_DAYS);
  });

  test('clamps to the same [1, 90] range the API enforces', () => {
    expect(clampAdminAnalyticsDays(0)).toBe(ADMIN_ANALYTICS_MIN_DAYS);
    expect(clampAdminAnalyticsDays(-10)).toBe(ADMIN_ANALYTICS_MIN_DAYS);
    expect(clampAdminAnalyticsDays(365)).toBe(ADMIN_ANALYTICS_MAX_DAYS);
    expect(clampAdminAnalyticsDays(7)).toBe(7);
  });

  test('truncates a fractional value so the query key stays stable', () => {
    // A float in the key would mint a separate cache entry per re-render if a
    // caller ever computed `days` from a ratio.
    expect(clampAdminAnalyticsDays(7.9)).toBe(7);
  });
});

describe('useAdminActivityAnalytics', () => {
  test('keys the query by the clamped day count', () => {
    const hook = useAdminActivityAnalytics(7) as any;
    expect(hook.queryKey).toEqual(['admin', 'analytics', 'activity', 7]);
  });

  test('clamps an out-of-range day count in the key AND the request', async () => {
    const hook = useAdminActivityAnalytics(9999) as any;
    expect(hook.queryKey).toEqual(['admin', 'analytics', 'activity', ADMIN_ANALYTICS_MAX_DAYS]);
    await hook.queryFn();
    expect(calls).toEqual([
      { method: 'GET', path: `/admin/analytics/activity?days=${ADMIN_ANALYTICS_MAX_DAYS}` },
    ]);
  });

  test('defaults to 30 days when called with no argument', async () => {
    const hook = useAdminActivityAnalytics() as any;
    expect(hook.queryKey).toEqual([
      'admin',
      'analytics',
      'activity',
      ADMIN_ANALYTICS_DEFAULT_DAYS,
    ]);
    await hook.queryFn();
    expect(calls[0]!.path).toBe(`/admin/analytics/activity?days=${ADMIN_ANALYTICS_DEFAULT_DAYS}`);
  });

  test('returns the response body', async () => {
    nextData = {
      days: [
        {
          date: '2026-08-07',
          sessionsCreated: 3,
          activeAccounts: 2,
          activeUsers: 2,
          newAccounts: 1,
          activeProjects: 2,
        },
      ],
      summary: {
        sessionsLast7d: 3,
        sessionsPrev7d: 1,
        dau: 2,
        wau: 2,
        mau: 5,
        totalAccounts: 10,
        totalProjects: 12,
      },
    };
    const hook = useAdminActivityAnalytics(30) as any;
    await expect(hook.queryFn()).resolves.toEqual(nextData);
  });

  test('throws the API error message instead of resolving undefined', async () => {
    nextError = { message: 'admin role required' };
    const hook = useAdminActivityAnalytics(30) as any;
    await expect(hook.queryFn()).rejects.toThrow('admin role required');
  });

  test('keeps the previous page of data while a new range loads', () => {
    // Without this the charts unmount to a skeleton on every range change.
    const hook = useAdminActivityAnalytics(30) as any;
    expect(hook.placeholderData({ days: [], summary: {} })).toEqual({ days: [], summary: {} });
    expect(typeof hook.staleTime).toBe('number');
  });
});

describe('useAdminUsageAnalytics', () => {
  test('keys the query by the clamped day count', () => {
    const hook = useAdminUsageAnalytics(14) as any;
    expect(hook.queryKey).toEqual(['admin', 'analytics', 'usage', 14]);
  });

  test('requests the usage route with the day count', async () => {
    const hook = useAdminUsageAnalytics(14) as any;
    await hook.queryFn();
    expect(calls).toEqual([{ method: 'GET', path: '/admin/analytics/usage?days=14' }]);
  });

  test('does not collide with the activity query key', () => {
    const activity = useAdminActivityAnalytics(30) as any;
    const usage = useAdminUsageAnalytics(30) as any;
    expect(activity.queryKey).not.toEqual(usage.queryKey);
  });

  test('throws the API error message', async () => {
    nextError = { message: 'boom' };
    const hook = useAdminUsageAnalytics(30) as any;
    await expect(hook.queryFn()).rejects.toThrow('boom');
  });
});
