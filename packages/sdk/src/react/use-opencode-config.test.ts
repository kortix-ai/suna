import { expect, mock, test } from 'bun:test';

let runtimeUrl: string | null = 'https://api.test/v1/p/worker-a/8000';
let query: any;
let mutation: any;
const readUrls: string[] = [];
const queryClient = {
  cancelQueries: mock(async () => {}), getQueryData: mock(() => ({ model: 'old' })),
  setQueryData: mock((_key: readonly unknown[], _value: unknown) => {}),
  refetchQueries: mock(async (_options: { queryKey: readonly unknown[]; type: string }) => {}),
};
const client = (url: string) => ({ global: { config: {
  get: async () => { readUrls.push(url); return { data: { model: url } }; },
  update: async () => ({ data: { model: url } }),
} } });
mock.module('@tanstack/react-query', () => ({
  useQuery: (options: any) => { query = options; return options; },
  useMutation: (options: any) => { mutation = options; return options; },
  useQueryClient: () => queryClient,
}));
mock.module('../core/runtime/client', () => ({
  getClient: () => client(runtimeUrl!), getClientForUrl: client,
}));
mock.module('./use-current-runtime', () => ({
  useCurrentRuntime: (select: (state: { url: string | null }) => unknown) => select({ url: runtimeUrl }),
}));
mock.module('./use-opencode-sessions/keys', () => ({ useOpenCodeRuntimeReady: () => true }));

const { useOpenCodeConfig, useUpdateOpenCodeConfig } = await import('./use-opencode-config');

test('runtime config reads retain their own URL and separate cache while sessions switch', async () => {
  useOpenCodeConfig();
  const first = query;
  const firstUrl = runtimeUrl;
  runtimeUrl = 'https://api.test/v1/p/worker-b/8000';
  useOpenCodeConfig();
  expect(first.queryKey).not.toEqual(query.queryKey);
  expect(first.queryKey).toContain(firstUrl);
  await first.queryFn();
  await query.queryFn();
  expect(readUrls).toEqual([firstUrl!, runtimeUrl]);
  runtimeUrl = null;
  useOpenCodeConfig();
  expect(query.enabled).toBe(false);
});

test('a failed runtime config update restores only its original cache entry', async () => {
  runtimeUrl = 'https://api.test/v1/p/worker-a/8000';
  useUpdateOpenCodeConfig();
  const original = mutation;
  const context = await original.onMutate({ model: 'new' });
  runtimeUrl = 'https://api.test/v1/p/worker-b/8000';
  useUpdateOpenCodeConfig();
  mutation.onError(new Error('rejected'), { model: 'new' }, context);
  expect(queryClient.setQueryData.mock.calls.at(-1)).toEqual([
    ['opencode', 'config', 'https://api.test/v1/p/worker-a/8000'], { model: 'old' },
  ]);
  mutation.onSettled(undefined, new Error('rejected'), {}, context);
  expect(queryClient.refetchQueries.mock.calls.at(-1)).toEqual([{
    queryKey: ['opencode', 'config', 'https://api.test/v1/p/worker-a/8000'], type: 'active',
  }]);
});
