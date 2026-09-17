import { afterEach, beforeEach, expect, mock, setSystemTime, test } from 'bun:test';
import { configureKortix } from '../core/http/config';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; setSystemTime(); });
let invalidated: unknown[][] = [];
mock.module('@tanstack/react-query', () => ({
  useQuery: (options: unknown) => options,
  useMutation: (options: unknown) => options,
  useQueryClient: () => ({ invalidateQueries: async ({ queryKey }: { queryKey: unknown[] }) => { invalidated.push(queryKey); } }),
}));
const { useAccountSecretResources, useSessionProviderSecretPools } = await import('./use-provider-secrets');

beforeEach(() => {
  invalidated = [];
  configureKortix({ backendUrl: 'http://provider-secrets.test', getToken: async () => 'test-token' });
});

test('missing account or session identity cannot enable a request', () => {
  expect((useAccountSecretResources(null) as any).enabled).toBe(false);
  expect((useSessionProviderSecretPools('project', null) as any).enabled).toBe(false);
  expect((useSessionProviderSecretPools(null, 'session') as any).enabled).toBe(false);
});

test('pool updates and cache invalidation stay bound to the same project and session', async () => {
  const calls: string[] = [];
  globalThis.fetch = mock(async (url: unknown) => {
    calls.push(String(url));
    return Response.json({ provider_id: 'anthropic', configured: true, secret_ids: [] });
  }) as unknown as typeof fetch;
  const own = useSessionProviderSecretPools('own-project', 'own-session') as any;
  const sibling = useSessionProviderSecretPools('own-project', 'sibling-session') as any;
  await own.setPool.mutationFn({ providerId: 'anthropic', secretIds: [] });
  await own.setPool.onSuccess();
  expect(calls).toEqual(['http://provider-secrets.test/projects/own-project/sessions/own-session/provider-secret-pools/anthropic']);
  expect(invalidated).toContainEqual(own.queryKey);
  expect(invalidated).not.toContainEqual(sibling.queryKey);
});

test('account resources are queried through the public REST contract without values', async () => {
  const expected = { secrets: [{ secret_id: 'key', can_use: false }] };
  globalThis.fetch = mock(async (url: unknown) => {
    expect(String(url)).toBe('http://provider-secrets.test/accounts/account/secret-resources');
    return Response.json(expected);
  }) as unknown as typeof fetch;
  expect(await (useAccountSecretResources('account') as any).queryFn()).toEqual(expected);
});

test('resource metadata refreshes when the nearest cooldown expires, then stops polling', () => {
  const now = new Date('2026-09-17T07:00:00Z');
  setSystemTime(now);
  const query = useAccountSecretResources('account') as any;
  const state = { data: { secrets: [
    { cooldown_until: '2026-09-17T07:00:07Z' },
    { cooldown_until: '2026-09-17T07:01:00Z' },
  ] } };
  expect(query.refetchInterval({ state })).toBe(7000);
  setSystemTime(new Date('2026-09-17T07:00:07Z'));
  expect(query.refetchInterval({ state })).toBe(53000);
  setSystemTime(new Date('2026-09-17T07:01:01Z'));
  expect(query.refetchInterval({ state })).toBe(false);
  expect(query.refetchInterval({ state: {} })).toBe(false);
});
