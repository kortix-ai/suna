import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '../core/http/api/errors';

// Engine-level proof for the 4xx no-retry rule (see
// `use-opencode-sessions/providers.test.ts` for the callback-level tests).
// The real React Query engine runs each hook's own queryFn + retry config, so
// the fetch count is the observable: a dead-token 401 must produce ONE fetch.
// The web app's QueryClient defaults are mirrored here
// (`apps/web/src/app/react-query-provider.tsx`): never retry 4xx.
//
// Prod measured the bug before the fix: 11 `GET /projects/:id/model-picker`
// warn lines in 65 s (retry: 10, backoff 1, 2, 4, then 8 s x7) and 8
// `GET /tunnel/connections` warn lines (two default-retry cycles of 1/2/4 s).

let pickerFetches = 0;
let tunnelFetches = 0;
let listFetches = 0;
let runtimeListResult: unknown = null;
let detailData: unknown = { project: { experimental: { llm_gateway: true } } };

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

mock.module('./route-project', () => ({
  useKortixRouteProjectId: () => 'P1',
}));

mock.module('./use-opencode-sessions/keys', () => ({
  useRuntimeReady: () => true,
  runtimeKeys: { providers: () => ['runtime', 'providers'] },
}));

mock.module('../core/rest/projects-client', () => ({
  getProjectDetail: async () => ({ project: { experimental: { llm_gateway: true } } }),
  getProjectModelPicker: async () => {
    pickerFetches++;
    throw new ApiError('Invalid or expired token', { status: 401 });
  },
  getProjectLlmCatalogProviders: async () => ({ providers: [] }),
  listProjectSecrets: async () => ({ items: [] }),
  addComputerToProject: async () => ({ tunnelId: 'tunnel-1' }),
}));

const actualApiClient: Record<string, unknown> = await import('../core/http/api-client');
mock.module('../core/runtime/client', () => ({
  getClient: () => ({
    provider: {
      list: async () => {
        listFetches++;
        if (runtimeListResult) return runtimeListResult;
        return { data: [{ id: 'p1', models: [{ id: 'm1' }] }] };
      },
    },
  }),
}));

mock.module('../core/http/api-client', () => ({
  ...actualApiClient,
  backendApi: {
    get: async () => {
      tunnelFetches++;
      return { success: false, error: new ApiError('Invalid or expired token', { status: 401 }) };
    },
    post: async () => ({ success: true, data: {} }),
    put: async () => ({ success: true, data: {} }),
    patch: async () => ({ success: true, data: {} }),
    delete: async () => ({ success: true, data: {} }),
  },
}));

/** The web host's default query retry (`react-query-provider.tsx`). */
const webDefaultRetry = (failureCount: number, error: unknown): boolean => {
  const status = (error as { status?: number } | null)?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) return false;
  return failureCount < 3;
};

const providers = (await import('./use-opencode-sessions/providers')) as unknown as {
  useRuntimeProviders: () => {
    queryFn: () => Promise<unknown>;
    retry: (failureCount: number, error: unknown) => boolean;
  };
};
const tunnel = (await import('./use-tunnel')) as unknown as {
  useTunnelConnections: () => { queryFn: () => Promise<unknown> };
};

beforeEach(() => {
  pickerFetches = 0;
  tunnelFetches = 0;
  listFetches = 0;
  detailData = { project: { experimental: { llm_gateway: true } } };
  runtimeListResult = null;
});

describe('dead-token 401 runs one fetch, not a retry storm', () => {
  test('model-picker gateway query: retry:10 stays out of a 401', async () => {
    const config = providers.useRuntimeProviders();
    const client = new QueryClient();
    await client
      .fetchQuery({
        queryKey: ['engine-test', 'model-picker'],
        queryFn: config.queryFn,
        retry: config.retry,
        retryDelay: 5,
      })
      .catch(() => {});
    expect(pickerFetches).toBe(1);
  });

  test('tunnel connections poller: the preserved status engages the web guard', async () => {
    const config = tunnel.useTunnelConnections();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: webDefaultRetry, retryDelay: 5 } },
    });
    await client
      .fetchQuery({ queryKey: ['engine-test', 'tunnel-connections'], queryFn: config.queryFn })
      .catch(() => {});
    expect(tunnelFetches).toBe(1);
  });

  test('native provider query: a dead-token 401 on the runtime proxy runs one fetch', async () => {
    // The runtime REST client NEVER throws for an HTTP error — it resolves
    // `{ error, response }` — so before the unwrap fix the native queryFn threw
    // a status-less Error and this 401 stormed 11 fetches through `retry: 10`.
    detailData = { project: { experimental: { llm_gateway: false } } };
    runtimeListResult = { error: { detail: 'Invalid or expired token' }, request: {}, response: { status: 401 } };
    const config = providers.useRuntimeProviders();
    const client = new QueryClient();
    await client
      .fetchQuery({
        queryKey: ['engine-test', 'native-providers-401'],
        queryFn: config.queryFn,
        retry: config.retry,
        retryDelay: 5,
      })
      .catch(() => {});
    expect(listFetches).toBe(1);
  });

  test('native provider query: the boot race (empty provider list) still retries', async () => {
    detailData = { project: { experimental: { llm_gateway: false } } };
    runtimeListResult = { data: {} };
    const config = providers.useRuntimeProviders();
    const client = new QueryClient();
    await client
      .fetchQuery({
        queryKey: ['engine-test', 'native-providers-boot'],
        queryFn: config.queryFn,
        retry: config.retry,
        retryDelay: 5,
      })
      .catch(() => {});
    // The boot-race guard is the over-fix tripwire: the status-less error must
    // still run its full retry budget (1 initial + 10 retries). If a future
    // edit made the 4xx guard swallow status-less errors too, this drops to 1.
    expect(listFetches).toBe(11);
  });
});
