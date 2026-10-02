import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { ApiError } from '../../core/http/api/errors';

// `useRuntimeProviders` owns the two aggressive retry policies in the picker
// layer (`retry: 10`, backoff capped at 8 s). A 401 from a dead token is
// permanent — retrying it cannot succeed, and prod logged the result as an
// 11-request warn storm on `GET /projects/:id/model-picker` over 65 s
// (backoff 1, 2, 4, then 8 s x7). Same harness as `../use-tunnel.test.ts`:
// react-query is reduced to identity functions so a hook returns its config.

let detailData: unknown = null;

mock.module('react', () => ({
  useMemo: (fn: () => unknown) => fn(),
  useContext: () => null,
}));

mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => ({
    ...config,
    data: detailData,
    isSuccess: true,
    isLoading: false,
  }),
  useMutation: (config: Record<string, unknown>) => config,
  useQueryClient: () => ({
    fetchQuery: async (opts: { queryFn: () => Promise<unknown> }) => opts.queryFn(),
    invalidateQueries: () => {},
    getQueryData: () => undefined,
  }),
}));

mock.module('../route-project', () => ({
  useKortixRouteProjectId: () => 'P1',
}));

mock.module('./keys', () => ({
  useRuntimeReady: () => true,
  runtimeKeys: { providers: () => ['runtime', 'providers'] },
}));

mock.module('../../core/rest/projects-client', () => ({
  getProjectDetail: async () => detailData,
  getProjectModelPicker: async () => ({ models: [] }),
  getProjectLlmCatalogProviders: async () => ({ providers: [] }),
  listProjectSecrets: async () => ({ items: [] }),
}));

const providers = await import('./providers');

beforeEach(() => {
  detailData = { project: { experimental: { llm_gateway: true } } };
});

type Config = { retry?: (failureCount: number, error: unknown) => boolean };

describe('useRuntimeProviders gateway query retry policy', () => {
  test('does not retry a 401 from a dead token', () => {
    const config = providers.useRuntimeProviders() as Config;
    expect(config.retry!(0, new ApiError('Invalid or expired token', { status: 401 }))).toBe(false);
  });

  test('does not retry any 4xx client error', () => {
    const config = providers.useRuntimeProviders() as Config;
    for (const status of [400, 401, 403, 404, 429]) {
      expect(config.retry!(0, new ApiError('client error', { status }))).toBe(false);
    }
  });

  test('still retries transient 5xx and status-less failures up to the cap', () => {
    const config = providers.useRuntimeProviders() as Config;
    const gateway503 = new ApiError('request_deadline', { status: 503 });
    expect(config.retry!(0, gateway503)).toBe(true);
    expect(config.retry!(9, gateway503)).toBe(true);
    expect(config.retry!(10, gateway503)).toBe(false);
    expect(config.retry!(0, new Error('transport failure'))).toBe(true);
  });
});

describe('useRuntimeProviders native query retry policy', () => {
  test('does not retry a 401 from a dead token', () => {
    detailData = { project: { experimental: { llm_gateway: false } } };
    const config = providers.useRuntimeProviders() as Config;
    expect(config.retry!(0, new ApiError('Invalid or expired token', { status: 401 }))).toBe(false);
  });

  test('still retries the status-less boot race (no connected models yet) up to the cap', () => {
    detailData = { project: { experimental: { llm_gateway: false } } };
    const config = providers.useRuntimeProviders() as Config;
    const bootRace = new Error(
      'opencode provider list has no connected models yet — sandbox still warming up',
    );
    expect(config.retry!(0, bootRace)).toBe(true);
    expect(config.retry!(10, bootRace)).toBe(false);
  });
});
