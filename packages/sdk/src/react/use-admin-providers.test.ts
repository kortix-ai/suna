import { beforeEach, expect, mock, test } from 'bun:test';
import type { UseQueryOptions, UseMutationOptions } from '@tanstack/react-query';
let query: UseQueryOptions = { queryKey: [] };
let mutation: UseMutationOptions<unknown, Error, unknown> = {};
let calls: unknown[] = [];
let error: { message: string } | null = null;
let events: unknown[] = [];
let responseData: unknown = null;
mock.module('@tanstack/react-query', () => ({
  useQuery: (options: UseQueryOptions) => { query = options; return options; },
  useMutation: (options: UseMutationOptions<unknown, Error, unknown>) => { mutation = options; return options; },
  useQueryClient: () => ({ invalidateQueries: (options: unknown) => { events.push(options); return new Promise(() => {}); } }),
}));
mock.module('../core/http/api-client', () => ({ backendApi: Object.fromEntries(['get', 'put', 'post'].map(method => [method, async (path: string, body?: unknown) => { calls.push({ method, path, body }); return { success: !error, data: responseData, error: error ? new Error(error.message) : undefined }; }])) }));
const hooks = await import('./use-admin-providers');
beforeEach(() => { calls = []; events = []; error = null; });
async function runQuery() {
  const fn = query.queryFn;
  if (typeof fn !== 'function') throw new Error('Missing query function');
  // The request functions have no query-context dependency.
  return Reflect.apply(fn, undefined, []);
}
async function runMutation(variables: unknown) {
  if (!mutation.mutationFn) throw new Error('Missing mutation function');
  return Reflect.apply(mutation.mutationFn, undefined, [variables]);
}
test('four query contracts preserve keys, intervals, enabled and requests', async () => {
  for (const [hook, key, path, interval] of [
    [hooks.useAdminProviderDistribution, ['admin', 'provider-distribution'], '/admin/api/provider-distribution', undefined],
    [hooks.useAdminProviderSandboxes, ['admin', 'sandboxes'], '/admin/api/sandboxes?limit=300', 10000],
    [hooks.useAdminProviderFallback, ['admin', 'provider-fallback'], '/admin/api/provider-fallback', undefined],
  ] satisfies [() => unknown, string[], string, number | undefined][]) {
    hook(); expect(query.queryKey).toEqual(key); expect(query.refetchInterval).toBe(interval);
    responseData = { contract: key[1], rows: [1, 2] };
    expect(await runQuery()).toEqual(responseData);
    error = { message: `denied:${path}` };
    await expect(runQuery()).rejects.toThrow(`denied:${path}`);
    error = null;
    expect(calls.at(-1)).toEqual({ method: 'get', path, body: undefined });
  }
  for (const days of [7, 30]) for (const enabled of [false, true]) {
    hooks.useAdminProviderAnalytics(days, enabled);
    expect(query.queryKey).toEqual(['admin', 'provider-analytics', days]);
    expect(query.enabled).toBe(enabled); expect(query.refetchInterval).toBe(enabled ? 30000 : false);
    responseData = { days, providers: [{ provider: 'platinum', ok: days }] };
    expect(await runQuery()).toEqual(responseData);
    expect(calls.at(-1)).toEqual({ method: 'get', path: `/admin/api/provider-analytics?days=${days}`, body: undefined });
    error = { message: `analytics:${days}` };
    await expect(runQuery()).rejects.toThrow(`analytics:${days}`);
    error = null;
  }
  error = { message: 'admin_required' };
  await expect(runQuery()).rejects.toThrow('admin_required');
});
test('mutations accept explicit variables and run host success before fire-and-forget invalidation', async () => {
  const options = { onSuccess: () => { events.push('host'); }, onError: (e: Error) => { events.push(e.message); } };
  for (const [hook, variables, method, path, body, key] of [
    [() => hooks.useSetAdminProviderDistribution(options), { platinum: 2 }, 'put', '/admin/api/provider-distribution', { platinum: 2 }, 'provider-distribution'],
    [() => hooks.useMigrateAdminSandboxProvider(options), { sessionId: 's/a', targetProvider: 'platinum' }, 'post', '/admin/api/sandboxes/s%2Fa/migrate', { targetProvider: 'platinum' }, 'sandboxes'],
    [() => hooks.useSetAdminProviderFallback(options), false, 'put', '/admin/api/provider-fallback', { enabled: false }, 'provider-fallback'],
    [() => hooks.useSetAdminProviderDistribution(options), { platinum: 0, daytona: 9 }, 'put', '/admin/api/provider-distribution', { platinum: 0, daytona: 9 }, 'provider-distribution'],
    [() => hooks.useMigrateAdminSandboxProvider(options), { sessionId: 'second ?#', targetProvider: 'daytona' }, 'post', '/admin/api/sandboxes/second%20%3F%23/migrate', { targetProvider: 'daytona' }, 'sandboxes'],
    [() => hooks.useSetAdminProviderFallback(options), true, 'put', '/admin/api/provider-fallback', { enabled: true }, 'provider-fallback'],
  ] satisfies [() => unknown, unknown, string, string, unknown, string][]) {
    events = []; responseData = { saved: body, path }; hook(); const data = await runMutation(variables);
    expect(data).toEqual(responseData);
    expect(calls.at(-1)).toEqual({ method, path, body });
    if (!mutation.onSuccess) throw new Error('Missing success callback');
    expect(Reflect.apply(mutation.onSuccess, undefined, [data, variables])).toBeUndefined();
    expect(events).toEqual(['host', { queryKey: ['admin', key] }]);
    error = { message: 'denied' }; await expect(runMutation(variables)).rejects.toThrow('denied'); error = null;
    if (!mutation.onError) throw new Error('Missing error callback');
    Reflect.apply(mutation.onError, undefined, [new Error('denied'), variables]); expect(events.at(-1)).toBe('denied');
  }
});
