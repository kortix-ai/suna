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
  listChromeConnections: async () => {
    calls.push(['list']);
    return [];
  },
  updateChromeConnection: async (id: string, update: unknown) => {
    calls.push(['update', id, update]);
    return { id };
  },
  deleteChromeConnection: async (id: string) => {
    calls.push(['delete', id]);
  },
}));

const { chromeKeys, useChromeConnections, useUpdateChromeConnection, useDeleteChromeConnection } = await import('./use-chrome-connections');

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

test('chromeKeys nests under one root key', () => {
  expect(chromeKeys.all).toEqual(['chrome']);
  expect(chromeKeys.list()).toEqual(['chrome', 'list']);
});

test('useChromeConnections lists browsers and polls every 5 s by default', async () => {
  const config = useChromeConnections() as unknown as Config;
  expect(config.queryKey).toEqual(chromeKeys.list());
  expect(config.refetchInterval).toBe(5_000);
  await config.queryFn!();
  expect(calls).toEqual([['list']]);
});

test('useChromeConnections takes a custom or disabled refetchInterval', () => {
  expect((useChromeConnections({ refetchInterval: 3_000 }) as unknown as Config).refetchInterval).toBe(3_000);
  expect((useChromeConnections({ refetchInterval: false }) as unknown as Config).refetchInterval).toBe(false);
});

test('useUpdateChromeConnection patches the browser and refreshes the list', async () => {
  const config = useUpdateChromeConnection() as unknown as Config;
  await config.mutationFn!({ id: 'b1', name: 'Home', tabScope: 'all' });
  expect(calls).toEqual([['update', 'b1', { name: 'Home', tabScope: 'all' }]]);
  config.onSuccess!();
  expect(invalidated).toEqual([chromeKeys.list()]);
});

test('useDeleteChromeConnection deletes the browser and refreshes the list', async () => {
  const config = useDeleteChromeConnection() as unknown as Config;
  await config.mutationFn!('b1');
  expect(calls).toEqual([['delete', 'b1']]);
  config.onSuccess!();
  expect(invalidated).toEqual([chromeKeys.list()]);
});
