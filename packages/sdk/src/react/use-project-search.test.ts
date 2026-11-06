import { beforeEach, expect, mock, test } from 'bun:test';

// Same harness as `./use-project-memory.test.ts`: `useQuery` returns its
// config so the wiring is asserted without a render tree.
const keepPreviousData = (previous: unknown) => previous;
mock.module('@tanstack/react-query', () => ({
  keepPreviousData,
  useQuery: (config: Record<string, unknown>) => config,
}));

const { useWorkspaceSearch } = await import('./use-project-search');
const { qk } = await import('./query-keys');
const { configureKortix } = await import('../core/http/config');

let calls: string[] = [];
beforeEach(() => {
  calls = [];
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  globalThis.fetch = mock(async (url: unknown) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ hits: [], next_cursor: null }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});

test('useProjectSearch reads one query under the project scope, q trimmed, previous hits kept', async () => {
  const search = useWorkspaceSearch('P1', { q: '  q3 plan ', path: '/Company', limit: 5 }) as any;
  expect(search.queryKey).toEqual(qk.project.search('P1', { q: 'q3 plan', path: '/Company', limit: 5 }));
  const scope = qk.project.scope('P1');
  expect(search.queryKey.slice(0, scope.length)).toEqual([...scope]);
  expect(search.enabled).toBe(true);
  expect(search.placeholderData).toBe(keepPreviousData);
  expect(await search.queryFn()).toEqual({ hits: [], next_cursor: null });
  expect(calls).toEqual(['http://test.local/workspaces/P1/search?q=q3+plan&path=%2FCompany&limit=5']);
});

test('useProjectSearch stays off for an empty or over-long q, no project, or enabled: false', () => {
  expect((useWorkspaceSearch('P1', { q: '   ' }) as any).enabled).toBe(false);
  expect((useWorkspaceSearch('P1', { q: 'x'.repeat(201) }) as any).enabled).toBe(false);
  expect((useWorkspaceSearch(null, { q: 'plan' }) as any).enabled).toBe(false);
  expect((useWorkspaceSearch('P1', { q: 'plan' }, { enabled: false }) as any).enabled).toBe(false);
  expect((useWorkspaceSearch('P1', { q: 'p' }) as any).enabled).toBe(true);
});
