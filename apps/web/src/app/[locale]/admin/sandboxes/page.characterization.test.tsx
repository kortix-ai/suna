import { expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { act, create } from 'react-test-renderer';
import type { UseQueryOptions, UseMutationOptions } from '@tanstack/react-query';
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
const distribution = { allowed: ['platinum', 'daytona'], default: 'platinum', weights: { platinum: 2, daytona: 1 } };
const sandbox = { sandboxId: 'synthetic-sandbox', sessionId: 'synthetic/session', accountId: 'synthetic-account', projectId: 'synthetic-project', provider: 'platinum', externalId: 'synthetic-external', status: 'active', lastUsedAt: null };
const fallback = { enabled: false };
let interactive = false;
const writes: unknown[] = [];
const results: unknown[] = [];
function request(method: string, path: string, body?: unknown) {
  writes.push({ method, path, body });
  return Promise.resolve({ success: true, data: { saved: body, path } });
}
const apiExports = await import('../../../../../../../packages/sdk/src/core/http/api-client');
mock.module('../../../../../../../packages/sdk/src/core/http/api-client', () => ({ ...apiExports, backendApi: {
  get: (path: string) => request('get', path),
  put: (path: string, body: unknown) => request('put', path, body),
  post: (path: string, body: unknown) => request('post', path, body),
} }));
const invalidations: unknown[] = [];
const toasts: string[] = [];
const refreshes: unknown[] = [];
let queries: UseQueryOptions[] = [];
let mutations: UseMutationOptions<unknown, Error, unknown>[] = [];
const queryExports = await import('@tanstack/react-query');
mock.module('@tanstack/react-query', () => ({
  ...queryExports,
  useQuery: (options: UseQueryOptions) => { queries.push(options); return { isLoading: !interactive, isFetching: false, data: !interactive ? undefined : options.queryKey[1] === 'provider-distribution' ? distribution : options.queryKey[1] === 'sandboxes' ? { sandboxes: [sandbox], byProvider: [{ provider: 'platinum', count: 1 }] } : options.queryKey[1] === 'provider-fallback' ? fallback : undefined, refetch: () => { refreshes.push(options.queryKey); } }; },
  useMutation: (options: UseMutationOptions<unknown, Error, unknown>) => { mutations.push(options); return { isPending: false, mutate: async (variables?: unknown) => { if (!options.mutationFn) throw new Error('Missing mutation function'); const data = await Reflect.apply(options.mutationFn, undefined, [variables]); results.push(data); if (options.onSuccess) await Reflect.apply(options.onSuccess, undefined, [data, variables]); } }; },
  useQueryClient: () => ({ invalidateQueries: (key: unknown) => { invalidations.push(key); return Promise.resolve(); } }),
}));
const passthrough = ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => createElement('div', props, children);
const translate = Object.assign((key: string) => key, { raw: (key: string) => key });
mock.module('@/i18n/use-translations', () => ({ useTranslations: () => translate }));
mock.module('@/i18n/use-localized-ui-catalog', () => ({ useLocalizedUiCatalog: (rows: unknown) => rows }));
mock.module('@/lib/utils', () => ({ cn: () => '' }));
mock.module('@/components/ui/toast', () => ({ errorToast: (message: string) => toasts.push(message), successToast: (message: string) => toasts.push(message) }));
mock.module('@phosphor-icons/react', () => ({ ArrowsLeftRightIcon: passthrough, DotsThreeIcon: passthrough }));
mock.module('recharts', () => ({ Area: passthrough, AreaChart: passthrough, Bar: passthrough, BarChart: passthrough, CartesianGrid: passthrough, XAxis: passthrough, YAxis: passthrough }));
mock.module('@/components/ui/badge', () => ({ Badge: passthrough }));
mock.module('@/components/ui/button', () => ({ Button: passthrough }));
mock.module('@/components/ui/chart', () => ({ ChartContainer: passthrough, ChartLegend: passthrough, ChartLegendContent: passthrough, ChartTooltip: passthrough, ChartTooltipContent: passthrough }));
mock.module('@/components/ui/dropdown-menu', () => ({ DropdownMenu: passthrough, DropdownMenuContent: passthrough, DropdownMenuItem: passthrough, DropdownMenuTrigger: passthrough }));
mock.module('@/components/ui/field', () => ({ Field: passthrough, FieldLabel: passthrough }));
mock.module('@/components/ui/hint', () => ({ default: passthrough }));
mock.module('@/components/ui/input', () => ({ Input: passthrough }));
mock.module('@/components/ui/kortix-icons', () => ({ IconInbox: passthrough }));
mock.module('@/components/ui/loading', () => ({ default: passthrough }));
mock.module('@/components/ui/modal', () => ({ Modal: passthrough, ModalContent: passthrough, ModalDescription: passthrough, ModalFooter: passthrough, ModalHeader: passthrough, ModalTitle: passthrough }));
mock.module('@/components/ui/select', () => ({ Select: passthrough, SelectContent: passthrough, SelectItem: passthrough, SelectTrigger: passthrough, SelectValue: passthrough }));
mock.module('@/components/ui/skeleton', () => ({ Skeleton: passthrough }));
mock.module('@/components/ui/switch', () => ({ Switch: passthrough }));
mock.module('@/components/ui/table', () => ({ Table: passthrough, TableBody: passthrough, TableCell: passthrough, TableHead: passthrough, TableHeader: passthrough, TableRow: passthrough }));
mock.module('@/components/ui/tabs', () => ({ Tabs: passthrough, TabsContent: passthrough, TabsList: passthrough, TabsTrigger: passthrough }));
mock.module('@/features/layout/section/empty-state', () => ({ EmptyState: passthrough }));
mock.module('../_components/admin-page-shell', () => ({ AdminPageShell: ({ children, action }: { children?: ReactNode; action?: ReactNode }) => createElement('main', null, action, children), AdminRefreshButton: passthrough }));
mock.module('../_components/admin-panel', () => ({ AdminEmptyFrame: passthrough, AdminPanel: passthrough, AdminSection: passthrough, AdminTableFrame: passthrough }));
mock.module('../_components/admin-table', () => ({ AdminSearch: passthrough }));
mock.module('../_components/stat-tile', () => ({ StatGrid: passthrough, StatGridSkeleton: passthrough, StatTile: passthrough }));

const { default: Page } = await import('./page');
test('rendered sandbox host configures all provider reads and writes', async () => {
  queries = []; mutations = [];
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => { renderer = create(createElement(Page)); });
  if (!renderer) throw new Error('Sandbox host did not render');
  expect(renderer.toJSON()).not.toBeNull();
  expect(queries.map(q => ({ key: q.queryKey, interval: q.refetchInterval, enabled: q.enabled }))).toEqual([
    { key: ['admin', 'provider-distribution'], interval: undefined, enabled: undefined },
    { key: ['admin', 'sandboxes'], interval: 10000, enabled: undefined },
    { key: ['admin', 'provider-analytics', 7], interval: false, enabled: false },
    { key: ['admin', 'provider-fallback'], interval: undefined, enabled: undefined },
  ]);
  expect(mutations).toHaveLength(3);
  for (const mutation of mutations) {
    expect(typeof mutation.mutationFn).toBe('function');
    expect(typeof mutation.onSuccess).toBe('function');
    expect(typeof mutation.onError).toBe('function');
  }
  await act(async () => { renderer?.unmount(); });
});

test('rendered drafts drive analytics, refresh, saves and migration confirmation', async () => {
  interactive = true; queries = []; mutations = []; writes.length = 0; results.length = 0; invalidations.length = 0; toasts.length = 0; refreshes.length = 0;
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => { renderer = create(createElement(Page)); });
  if (!renderer) throw new Error('Sandbox host did not render');
  const root = renderer.root;
  async function fire(prop: string, match: (props: Record<string, unknown>) => boolean, ...args: unknown[]) {
    const node = root.findAllByType('div').find(node => typeof node.props[prop] === 'function' && match(node.props));
    if (!node) throw new Error(`Missing event ${prop}`);
    const callback = node.props[prop];
    if (typeof callback !== 'function') throw new Error('Missing callback');
    await act(async () => { await Reflect.apply(callback, undefined, args); });
  }
  await fire('onValueChange', props => props.value === 'overview', 'analytics');
  expect(queries.at(-2)?.enabled).toBe(true);
  await fire('onValueChange', props => props.value === '7', '30');
  expect(queries.at(-2)?.queryKey).toEqual(['admin', 'provider-analytics', 30]);
  expect(queries.at(-2)?.refetchInterval).toBe(30000);
  await fire('onRefresh', () => true);
  expect(refreshes).toEqual([['admin', 'sandboxes'], ['admin', 'provider-analytics', 30]]);
  await fire('onChange', props => props.id === 'weight-platinum', { target: { value: '9' } });
  await fire('onClick', props => Array.isArray(props.children) && props.children.includes('text85457bd27cfc'));
  await fire('onCheckedChange', () => true, true);
  await fire('onClick', props => Array.isArray(props.children) && props.children.includes('text08cfb2899839'));
  await fire('onClick', props => Array.isArray(props.children) && props.children.includes('text969a25894852'));
  expect(root.findAllByType('div').some(node => node.props.open === true)).toBe(true);
  await fire('onValueChange', props => props.value === 'daytona', 'daytona');
  await fire('onClick', props => Array.isArray(props.children) && props.children.includes('textf988ed29d81b'));
  expect(writes).toEqual([
    { method: 'put', path: '/admin/api/provider-distribution', body: { platinum: 9, daytona: 1 } },
    { method: 'put', path: '/admin/api/provider-fallback', body: { enabled: true } },
    { method: 'post', path: '/admin/api/sandboxes/synthetic%2Fsession/migrate', body: { targetProvider: 'daytona' } },
  ]);
  expect(results).toEqual([
    { saved: { platinum: 9, daytona: 1 }, path: '/admin/api/provider-distribution' },
    { saved: { enabled: true }, path: '/admin/api/provider-fallback' },
    { saved: { targetProvider: 'daytona' }, path: '/admin/api/sandboxes/synthetic%2Fsession/migrate' },
  ]);
  expect(invalidations).toEqual([{ queryKey: ['admin', 'provider-distribution'] }, { queryKey: ['admin', 'provider-fallback'] }, { queryKey: ['admin', 'sandboxes'] }]);
  expect(toasts).toEqual(['textadf5fc6a2d24', 'textbc86ed0acea7', 'text44df00d3050e']);
  expect(root.findAllByType('div').some(node => node.props.open === true)).toBe(false);
  await act(async () => { renderer?.unmount(); });
  interactive = false;
});
