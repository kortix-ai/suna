import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create } from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The paged session hooks return the query with `sessions` added. A consumer
// that never reads `isFetching` must not re-render when a refetch starts and
// ends with the same rows.

const source = readFileSync(import.meta.dir + '/hooks.ts', 'utf8');
let pages: { items: { session_id: string }[]; next_cursor: string | null }[] = [];
const fakes: Record<string, Record<string, unknown>> = {
  './projects-client': {
    listProjectSessionsPage: async () => pages[0],
  },
  '@kortix/sdk/react': { useRuntimeProviders: () => null },
};
// Mock every module the hooks import except the ones the paged hooks run on.
const real = new Set(['react', '@tanstack/react-query', '@kortix/sdk', '@/lib/session/session-pages', '@/lib/session/session-tree', './poll-policy']);
for (const [, names, name] of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gs)) {
  if (real.has(name)) continue;
  const values: Record<string, unknown> = { ...fakes[name] };
  for (const item of names.split(',')) {
    const key = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
    if (key && !(key in values)) values[key] = () => null;
  }
  mock.module(name, () => values);
}

let hooks: typeof import('./hooks');
beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  hooks = await import('./hooks');
});

let tree: any;
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
  tree = undefined;
});

/** TanStack notifies observers on a timer: let every pending render land. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function mount(useList: () => { sessions: { session_id: string }[]; refetch: () => Promise<unknown> }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renders = 0;
  let list!: ReturnType<typeof useList>;
  function Consumer() {
    renders++;
    list = useList();
    // Reads only `sessions` (and the stable `refetch` below), as a list row does.
    list.sessions.length;
    return null;
  }
  await act(async () => {
    tree = create(React.createElement(QueryClientProvider, { client }, React.createElement(Consumer)));
  });
  await settle();
  return { renders: () => renders, list: () => list };
}

describe('paged session hooks', () => {
  test('useProjectSessionsPaged does not re-render a consumer on an isFetching flip', async () => {
    pages = [{ items: [{ session_id: 's-1' }], next_cursor: null }];
    const view = await mount(() => hooks.useProjectSessionsPaged('p-1', { poll: false, parent: 'root' }));
    expect(view.list().sessions.map((s) => s.session_id)).toEqual(['s-1']);
    const before = view.renders();
    // Same rows: only isFetching and dataUpdatedAt change.
    await act(async () => {
      await view.list().refetch();
    });
    await settle();
    expect(view.renders()).toBe(before);
    // New rows still reach the consumer.
    pages = [{ items: [{ session_id: 's-2' }], next_cursor: null }];
    await act(async () => {
      await view.list().refetch();
    });
    await settle();
    expect(view.list().sessions.map((s) => s.session_id)).toEqual(['s-2']);
    expect(view.renders()).toBeGreaterThan(before);
  });

  test('useSessionChildren does not re-render a consumer on an isFetching flip', async () => {
    pages = [{ items: [{ session_id: 'c-1' }], next_cursor: null }];
    const view = await mount(() => hooks.useSessionChildren('p-1', 'parent-1'));
    expect(view.list().sessions.map((s) => s.session_id)).toEqual(['c-1']);
    const before = view.renders();
    await act(async () => {
      await view.list().refetch();
    });
    await settle();
    expect(view.renders()).toBe(before);
  });

  test('the result still exposes every query field', async () => {
    pages = [{ items: [{ session_id: 's-1' }], next_cursor: 'c-2' }];
    const view = await mount(() => hooks.useProjectSessionsPaged('p-1', { poll: false }));
    const list = view.list() as any;
    expect(list.hasNextPage).toBe(true);
    expect(list.isPending).toBe(false);
    expect(list.isError).toBe(false);
    expect(list.isFetchingNextPage).toBe(false);
    expect(typeof list.fetchNextPage).toBe('function');
    expect(typeof list.dataUpdatedAt).toBe('number');
  });
});
