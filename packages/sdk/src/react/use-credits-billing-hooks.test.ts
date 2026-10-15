import { beforeEach, expect, mock, test } from 'bun:test';

// Same harness as `./retired-admin-hooks.test.ts`: react-query is reduced to
// identity functions so a hook returns its config and the test calls
// `mutationFn` / `onSuccess` directly.

let requests: Array<{ method: string; path: string; body?: unknown }> = [];
let invalidated: unknown[] = [];

mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
  useMutation: (config: Record<string, unknown>) => config,
  useQueryClient: () => ({
    invalidateQueries: (filter: unknown) => {
      invalidated.push(filter);
    },
  }),
}));

const record = (method: string) => async (path: string, body?: unknown) => {
  requests.push({ method, path, body });
  return { data: { status: 'updated', monthly_usd: 100, ok: true }, error: null, success: true };
};
mock.module('../core/http/api-client', () => ({
  backendApi: {
    get: record('GET'),
    post: record('POST'),
    put: record('PUT'),
    patch: record('PATCH'),
    delete: record('DELETE'),
  },
}));

const { useSetBillingPlan } = await import('./use-billing-plan');
const { useAdminGrantTrial } = await import('./use-admin-accounts');

beforeEach(() => {
  requests = [];
  invalidated = [];
});

test('useSetBillingPlan posts monthly_usd and invalidates account-state on success', async () => {
  const hook = useSetBillingPlan() as unknown as {
    mutationFn: (v: unknown) => Promise<unknown>;
    onSuccess: () => void;
  };
  const result = await hook.mutationFn({
    monthlyUsd: 100,
    successUrl: 'https://e.test/s',
    cancelUrl: 'https://e.test/c',
    accountId: 'acc-1',
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('POST');
  expect(requests[0].path).toBe('/billing/plan');
  expect(requests[0].body).toMatchObject({ monthly_usd: 100, account_id: 'acc-1' });
  expect(result).toEqual({ status: 'updated', monthly_usd: 100, ok: true });

  hook.onSuccess();
  expect(invalidated).toEqual([{ queryKey: ['account-state'] }]);
});

test('useAdminGrantTrial sends no seats and passes credit_grant', async () => {
  const hook = useAdminGrantTrial() as unknown as {
    mutationFn: (v: unknown) => Promise<unknown>;
  };
  await hook.mutationFn({
    accountId: 'acc-1',
    tierKey: 'credits',
    durationDays: 14,
    creditGrant: 25,
  });
  expect(requests[0].path).toBe('/admin/api/accounts/acc-1/trial');
  expect(requests[0].body).toEqual({ tier_key: 'credits', duration_days: 14, credit_grant: 25 });
});
