import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create } from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EMPTY_SESSION_PAGE_SCAN_LIMIT } from '@kortix/sdk/react';

// The paged session hooks return the query with `sessions` added. A consumer
// that never reads `isFetching` must not re-render when a refetch starts and
// ends with the same rows.

const source = readFileSync(import.meta.dir + '/hooks.ts', 'utf8');
type Page = { items: { session_id: string }[]; next_cursor: string | null };
// Page N answers cursor `c-N` (page 0 the first read); an Error entry fails that read.
let pages: (Page | Error)[] = [];
const cursors: (string | null)[] = [];
// A one-shot wait (ms) before the next read of a page index: a slow network.
const slow = new Map<number, number>();
const fakes: Record<string, Record<string, unknown>> = {
  './projects-client': {
    listProjectSessionsPage: async (_projectId: string, options: { cursor?: string | null }) => {
      const cursor = options.cursor ?? null;
      cursors.push(cursor);
      const index = cursor ? Number(cursor.slice(2)) : 0;
      const wait = slow.get(index);
      slow.delete(index);
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      const page = pages[index];
      if (page instanceof Error) throw page;
      return page;
    },
  },
};
// Mock every module the hooks import except the ones the paged hooks run on.
const real = new Set([
  'react',
  '@tanstack/react-query',
  '@kortix/sdk',
  '@kortix/sdk/react',
  '@/lib/session/session-pages',
  '@/lib/session/session-tree',
  './poll-policy',
]);
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

/** Settle until `done` holds: a scan reads several pages, one render apart. */
async function until(done: () => boolean) {
  for (let i = 0; i < 50 && !done(); i++) await settle();
}

async function mount(
  useList: () => { sessions: { session_id: string }[]; refetch: () => Promise<unknown> },
  seed?: (client: QueryClient) => void
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(client);
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
    expect(list.isScanning).toBe(false);
    expect(list.isPending).toBe(false);
    expect(list.isError).toBe(false);
    expect(list.isFetchingNextPage).toBe(false);
    expect(typeof list.fetchNextPage).toBe('function');
    expect(typeof list.dataUpdatedAt).toBe('number');
  });

  // KRTX-1727: the server drops rows the viewer may not see after a bounded
  // scan, so a page can be empty and still carry a cursor.
  test('reads past empty pages with a cursor until a row shows', async () => {
    pages = [
      { items: [], next_cursor: 'c-1' },
      { items: [], next_cursor: 'c-2' },
      { items: [{ session_id: 's-old' }], next_cursor: 'c-3' },
    ];
    cursors.length = 0;
    const view = await mount(() => hooks.useProjectSessionsPaged('p-1', { poll: false, parent: 'root', startedBy: 'others' }));
    await until(() => view.list().sessions.length > 0);
    expect(cursors).toEqual([null, 'c-1', 'c-2']);
    expect(view.list().sessions.map((s) => s.session_id)).toEqual(['s-old']);
    const list = view.list() as any;
    expect(list.isScanning).toBe(false);
    // The row's page has a cursor of its own: the viewer scrolls for it.
    expect(list.hasNextPage).toBe(true);
  });

  test('the scan stops at the SDK limit and leaves the next page to the viewer', async () => {
    pages = Array.from({ length: EMPTY_SESSION_PAGE_SCAN_LIMIT + 3 }, (_, index) => ({ items: [], next_cursor: `c-${index + 1}` }));
    cursors.length = 0;
    const view = await mount(() => hooks.useProjectSessionsPaged('p-1', { poll: false }));
    await until(() => cursors.length >= EMPTY_SESSION_PAGE_SCAN_LIMIT && !(view.list() as any).isFetching);
    await settle();
    expect(cursors).toHaveLength(EMPTY_SESSION_PAGE_SCAN_LIMIT);
    const list = view.list() as any;
    expect(list.sessions).toEqual([]);
    expect(list.isScanning).toBe(false);
    expect(list.hasNextPage).toBe(true);
  });

  test('a failed page ends the scan: no retry loop, the next page stays offered', async () => {
    pages = [{ items: [], next_cursor: 'c-1' }, new Error('offline')];
    cursors.length = 0;
    const view = await mount(() => hooks.useProjectSessionsPaged('p-1', { poll: false }));
    await until(() => (view.list() as any).isFetchNextPageError);
    for (let i = 0; i < 5; i++) await settle();
    expect(cursors).toEqual([null, 'c-1']);
    const list = view.list() as any;
    expect(list.isScanning).toBe(false);
    expect(list.hasNextPage).toBe(true);
  });

  test('a page with rows is not scanned past', async () => {
    pages = [{ items: [{ session_id: 's-1' }], next_cursor: 'c-1' }, { items: [], next_cursor: null }];
    cursors.length = 0;
    const view = await mount(() => hooks.useProjectSessionsPaged('p-1', { poll: false }));
    for (let i = 0; i < 5; i++) await settle();
    expect(cursors).toEqual([null]);
    expect((view.list() as any).isScanning).toBe(false);
  });

  // A refetch that answers the same pages keeps the same `data` (TanStack's
  // structural sharing). The scan must go on when that fetch ends, or the list
  // shows a loader with no exit.
  const emptyThenRow = (): (Page | Error)[] => [
    { items: [], next_cursor: 'c-1' },
    { items: [{ session_id: 's-old' }], next_cursor: null },
  ];

  test('a refetch during a scan page (the drawer opens, a pull to refresh) does not stall the scan', async () => {
    pages = emptyThenRow();
    cursors.length = 0;
    slow.set(1, 200);
    const view = await mount(() => hooks.useProjectSessionsPaged('p-1', { poll: false }));
    await until(() => cursors.length === 2);
    // refetch() cancels the scan page in flight; page one answers unchanged.
    await act(async () => {
      await view.list().refetch();
    });
    await until(() => view.list().sessions.length > 0);
    expect(cursors).toEqual([null, 'c-1', null, 'c-1']);
    expect(view.list().sessions.map((s) => s.session_id)).toEqual(['s-old']);
    expect((view.list() as any).isScanning).toBe(false);
  });

  test('a mount over a stale cached empty page with a cursor resumes the scan', async () => {
    pages = emptyThenRow();
    cursors.length = 0;
    // The persisted cache keeps page one only. Older than `staleTime`, so the mount refetches it.
    const view = await mount(
      () => hooks.useProjectSessionsPaged('p-1', { poll: false }),
      (client) =>
        client.setQueryData(
          hooks.projectKeys.projectSessionsPaged('p-1'),
          { pages: [{ items: [], next_cursor: 'c-1' }], pageParams: [null] },
          { updatedAt: Date.now() - 60_000 }
        )
    );
    await until(() => view.list().sessions.length > 0);
    expect(cursors).toEqual([null, 'c-1']);
    expect(view.list().sessions.map((s) => s.session_id)).toEqual(['s-old']);
  });

  test('a refresh after a failed scan page resumes the scan', async () => {
    pages = [{ items: [], next_cursor: 'c-1' }, new Error('offline')];
    cursors.length = 0;
    const view = await mount(() => hooks.useProjectSessionsPaged('p-1', { poll: false }));
    await until(() => (view.list() as any).isFetchNextPageError);
    pages[1] = { items: [{ session_id: 's-old' }], next_cursor: null };
    // Pull to refresh: page one answers unchanged, slow enough that the
    // render with the refetch running lands first.
    slow.set(0, 100);
    await act(async () => {
      await view.list().refetch();
    });
    await until(() => view.list().sessions.length > 0);
    expect(cursors).toEqual([null, 'c-1', null, 'c-1']);
    expect(view.list().sessions.map((s) => s.session_id)).toEqual(['s-old']);
  });

  test('a refetch that fails during a scan ends the scan: no loader without a fetch, the next page stays offered', async () => {
    pages = emptyThenRow();
    cursors.length = 0;
    slow.set(1, 200);
    const view = await mount(() => hooks.useProjectSessionsPaged('p-1', { poll: false }));
    await until(() => cursors.length === 2);
    pages[0] = new Error('offline');
    await act(async () => {
      await view.list().refetch();
    });
    // Past the cancelled scan page's late answer.
    for (let i = 0; i < 12; i++) await settle();
    const list = view.list() as any;
    expect(cursors).toEqual([null, 'c-1', null]);
    expect(list.isFetching).toBe(false);
    expect(list.isScanning).toBe(false);
    expect(list.hasNextPage).toBe(true);
  });
});
