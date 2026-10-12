import { beforeEach, expect, mock, test } from 'bun:test';

// Same harness as `./use-tunnel.test.ts`: react-query is reduced to identity
// functions so a hook returns its config.

let invalidated: Array<readonly unknown[]> = [];
const calls: Array<[string, ...unknown[]]> = [];

mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
  useMutation: (config: Record<string, unknown>) => config,
  useQueryClient: () => ({
    invalidateQueries: ({ queryKey }: { queryKey: readonly unknown[] }) => {
      invalidated.push(queryKey);
    },
  }),
}));

const actualRest = await import('../core/rest/projects-client');
mock.module('../core/rest/projects-client', () => ({
  ...actualRest,
  listBrowsers: async () => {
    calls.push(['list']);
    return [];
  },
  updateBrowser: async (id: string, update: unknown) => {
    calls.push(['update', id, update]);
    return { id };
  },
  deleteBrowser: async (id: string) => {
    calls.push(['delete', id]);
  },
}));

const { browserKeys, useBrowsers, useUpdateBrowser, useDeleteBrowser } = await import('./use-browsers');

type Config = {
  queryKey?: readonly unknown[];
  queryFn?: () => Promise<unknown>;
  mutationFn?: (vars: unknown) => Promise<unknown>;
  onSuccess?: () => void;
  refetchInterval?: unknown;
};

beforeEach(() => {
  invalidated = [];
  calls.length = 0;
});

test('browserKeys nests under one root key', () => {
  expect(browserKeys.all).toEqual(['browsers']);
  expect(browserKeys.list()).toEqual(['browsers', 'list']);
});

test('useBrowsers lists browsers and polls every 5 s by default', async () => {
  const config = useBrowsers() as unknown as Config;
  expect(config.queryKey).toEqual(browserKeys.list());
  expect(config.refetchInterval).toBe(5_000);
  await config.queryFn!();
  expect(calls).toEqual([['list']]);
});

test('useBrowsers takes a custom or disabled refetchInterval', () => {
  expect((useBrowsers({ refetchInterval: 3_000 }) as unknown as Config).refetchInterval).toBe(3_000);
  expect((useBrowsers({ refetchInterval: false }) as unknown as Config).refetchInterval).toBe(false);
});

test('useUpdateBrowser patches the browser and refreshes the list', async () => {
  const config = useUpdateBrowser() as unknown as Config;
  await config.mutationFn!({ id: 'b1', name: 'Home', tabScope: 'all' });
  expect(calls).toEqual([['update', 'b1', { name: 'Home', tabScope: 'all' }]]);
  config.onSuccess!();
  expect(invalidated).toEqual([browserKeys.list()]);
});

test('useDeleteBrowser deletes the browser and refreshes the list', async () => {
  const config = useDeleteBrowser() as unknown as Config;
  await config.mutationFn!('b1');
  expect(calls).toEqual([['delete', 'b1']]);
  config.onSuccess!();
  expect(invalidated).toEqual([browserKeys.list()]);
});
