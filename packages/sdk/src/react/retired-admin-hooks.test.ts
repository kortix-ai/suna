import { beforeEach, expect, mock, test } from 'bun:test';

// The API removed the admin analytics, feedback, system-status, billing-admin
// and per-sandbox admin routes. These hooks stay exported (public API until the
// next major) but fail at once with ENDPOINT_RETIRED instead of sending a
// request that can only 404. Same harness as `./use-admin-projects.test.ts`:
// react-query is reduced to identity functions so a hook returns its config.

let requests: string[] = [];

mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
  useMutation: (config: Record<string, unknown>) => config,
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}));

const record = (method: string) => async (path: string) => {
  requests.push(`${method} ${path}`);
  return { data: {}, error: null, success: true };
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

const analytics = await import('./use-admin-analytics');
const feedback = await import('./use-admin-feedback');
const sandboxes = await import('./use-admin-sandboxes');
const billing = await import('./use-admin-billing');
const systemStatus = await import('./use-system-status');
const accounts = await import('./use-admin-accounts');

beforeEach(() => {
  requests = [];
});

type Config = { queryFn?: () => Promise<unknown>; mutationFn?: (vars: unknown) => Promise<unknown> };

const RETIRED_HOOKS: Array<[name: string, hook: () => unknown]> = [
  ['useAnalyticsSummary', () => analytics.useAnalyticsSummary()],
  ['useThreadBrowser', () => analytics.useThreadBrowser()],
  ['useMessageDistribution', () => analytics.useMessageDistribution()],
  ['useCategoryDistribution', () => analytics.useCategoryDistribution()],
  ['useTierDistribution', () => analytics.useTierDistribution()],
  ['useVisitorStats', () => analytics.useVisitorStats()],
  ['useConversionFunnel', () => analytics.useConversionFunnel()],
  ['useRetentionData', () => analytics.useRetentionData()],
  ['useTranslate', () => analytics.useTranslate()],
  ['useARRWeeklyActuals', () => analytics.useARRWeeklyActuals()],
  ['useUpdateARRWeeklyActual', () => analytics.useUpdateARRWeeklyActual()],
  ['useDeleteARRWeeklyActual', () => analytics.useDeleteARRWeeklyActual()],
  ['useToggleFieldOverride', () => analytics.useToggleFieldOverride()],
  ['useARRSimulatorConfig', () => analytics.useARRSimulatorConfig()],
  ['useUpdateARRSimulatorConfig', () => analytics.useUpdateARRSimulatorConfig()],
  ['useSignupsByDate', () => analytics.useSignupsByDate('2026-01-01', '2026-01-31')],
  ['useViewsByDate', () => analytics.useViewsByDate('2026-01-01', '2026-01-31')],
  ['useNewPaidByDate', () => analytics.useNewPaidByDate('2026-01-01', '2026-01-31')],
  ['useChurnByDate', () => analytics.useChurnByDate('2026-01-01', '2026-01-31')],
  ['useARRMonthlyActuals', () => analytics.useARRMonthlyActuals()],
  ['useUpdateARRMonthlyActual', () => analytics.useUpdateARRMonthlyActual()],
  ['useDeleteARRMonthlyActual', () => analytics.useDeleteARRMonthlyActual()],
  ['useToggleMonthlyFieldOverride', () => analytics.useToggleMonthlyFieldOverride()],
  ['useRevenueSummary', () => analytics.useRevenueSummary()],
  ['useEngagementSummary', () => analytics.useEngagementSummary()],
  ['useTaskPerformance', () => analytics.useTaskPerformance()],
  ['useToolAdoption', () => analytics.useToolAdoption()],
  ['useProfitability', () => analytics.useProfitability()],
  ['useAdminFeedbackList', () => feedback.useAdminFeedbackList()],
  ['useAdminFeedbackStats', () => feedback.useAdminFeedbackStats()],
  ['useAdminSentimentSummary', () => feedback.useAdminSentimentSummary()],
  ['useAdminFeedbackTimeSeries', () => feedback.useAdminFeedbackTimeSeries()],
  ['useAdminRatingTrends', () => feedback.useAdminRatingTrends()],
  ['useAdminCriticalFeedback', () => feedback.useAdminCriticalFeedback()],
  ['useAdminFeedbackExport', () => feedback.useAdminFeedbackExport({})],
  ['useAdminFeedbackAnalysis', () => feedback.useAdminFeedbackAnalysis()],
  ['useAdminSandboxDetail', () => sandboxes.useAdminSandboxDetail('sandbox-1')],
  ['useAdminSandboxHealth', () => sandboxes.useAdminSandboxHealth('sandbox-1')],
  ['useAdminSandboxHealthBatch', () => sandboxes.useAdminSandboxHealthBatch(['sandbox-1'])],
  ['useAdminSandboxExec', () => sandboxes.useAdminSandboxExec()],
  ['useAdminSandboxAction', () => sandboxes.useAdminSandboxAction()],
  ['useAdminSandboxRepair', () => sandboxes.useAdminSandboxRepair()],
  ['useDeleteAdminSandbox', () => sandboxes.useDeleteAdminSandbox()],
  ['useUserBillingSummary', () => billing.useUserBillingSummary('user-1')],
  ['useAdminUserTransactions', () => billing.useAdminUserTransactions({ userId: 'user-1' })],
  ['useAdjustCredits', () => billing.useAdjustCredits()],
  ['useProcessRefund', () => billing.useProcessRefund()],
  ['useSystemStatus', () => systemStatus.useSystemStatus()],
  ['useUpdateMaintenanceNotice', () => systemStatus.useUpdateMaintenanceNotice()],
  ['useUpdateTechnicalIssue', () => systemStatus.useUpdateTechnicalIssue()],
  ['useClearSystemStatus', () => systemStatus.useClearSystemStatus()],
  ['useAdminAccountSandboxes', () => accounts.useAdminAccountSandboxes('account-1')],
];

test.each(RETIRED_HOOKS)('%s fails with ENDPOINT_RETIRED and sends no request', async (name, hook) => {
  const config = hook() as Config;
  const run = config.queryFn ? config.queryFn() : config.mutationFn!({});
  const error = await run.then(
    () => null,
    (e: unknown) => e,
  );

  expect((error as { code?: string } | null)?.code).toBe('ENDPOINT_RETIRED');
  expect((error as Error).message).toContain(name);
  expect(requests).toEqual([]);
});

test('fetchAdminSandboxProxyToken fails with ENDPOINT_RETIRED and sends no request', async () => {
  const error = await sandboxes.fetchAdminSandboxProxyToken('sandbox-1').catch((e: unknown) => e);
  expect((error as { code?: string }).code).toBe('ENDPOINT_RETIRED');
  expect(requests).toEqual([]);
});

test('the admin hooks backed by live routes still send their request', async () => {
  const config = sandboxes.useAdminSandboxes() as unknown as Config;
  await config.queryFn!();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toStartWith('GET /admin/api/sandboxes');
});
