import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create } from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// KRTX-2316: one session's row comes from its by-id read
// (`GET /projects/:id/sessions/:sid`), never from a `.find()` over the first
// list page. A session older than that page still has a row.

const source = readFileSync(import.meta.dir + '/hooks.ts', 'utf8');
type Row = { session_id: string; name: string };
const rows = new Map<string, Row>();
const reads: string[] = [];
let answer: Promise<void> = Promise.resolve();
const fakes: Record<string, Record<string, unknown>> = {
  './projects-client': {
    getProjectSession: async (projectId: string, sessionId: string) => {
      reads.push(`${projectId}/${sessionId}`);
      await answer;
      const row = rows.get(sessionId);
      if (!row) throw Object.assign(new Error('Not found'), { status: 404 });
      return row;
    },
  },
};
// Mock every module the hooks import except the ones this read runs on.
const real = new Set([
  'react',
  '@tanstack/react-query',
  '@kortix/sdk',
  '@kortix/sdk/react',
  '@/lib/session/session-pages',
  '@/lib/session/session-cache-write',
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
beforeEach(() => {
  rows.clear();
  reads.length = 0;
  answer = Promise.resolve();
});
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
  tree = undefined;
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function mount(sessionId: string | null, seed?: (client: QueryClient) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(client);
  let row: Row | null | undefined;
  function Consumer() {
    row = hooks.useProjectSession('p-1', sessionId).data as Row | undefined;
    return null;
  }
  await act(async () => {
    tree = create(React.createElement(QueryClientProvider, { client }, React.createElement(Consumer)));
  });
  return { client, row: () => row };
}

describe('useProjectSession (by id)', () => {
  test('reads a session older than the first page by id', async () => {
    rows.set('s-old', { session_id: 's-old', name: 'Older than page one' });
    const view = await mount('s-old', (client) => {
      client.setQueryData(hooks.projectKeys.projectSessions('p-1'), [{ session_id: 's-new', name: 'New' }]);
    });
    await settle();
    expect(reads).toEqual(['p-1/s-old']);
    expect(view.row()).toEqual({ session_id: 's-old', name: 'Older than page one' });
  });

  test('shows the row a cached list page holds while the read runs', async () => {
    rows.set('s-old', { session_id: 's-old', name: 'Fresh' });
    let release!: () => void;
    answer = new Promise((resolve) => {
      release = resolve;
    });
    const view = await mount('s-old', (client) => {
      client.setQueryData(hooks.projectKeys.projectSessionsPaged('p-1'), {
        pages: [{ items: [{ session_id: 's-old', name: 'Cached' }], next_cursor: null }],
        pageParams: [null],
      });
    });
    expect(view.row()).toEqual({ session_id: 's-old', name: 'Cached' });
    await act(async () => release());
    await settle();
    expect(view.row()).toEqual({ session_id: 's-old', name: 'Fresh' });
  });

  test('a session list invalidation refetches the row', async () => {
    rows.set('s-old', { session_id: 's-old', name: 'Before' });
    const view = await mount('s-old');
    await settle();
    rows.set('s-old', { session_id: 's-old', name: 'Renamed' });
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: hooks.projectKeys.projectSessions('p-1') });
    });
    await settle();
    expect(reads).toEqual(['p-1/s-old', 'p-1/s-old']);
    expect(view.row()).toEqual({ session_id: 's-old', name: 'Renamed' });
  });

  test('no id: no read', async () => {
    const view = await mount(null);
    await settle();
    expect(reads).toEqual([]);
    expect(view.row()).toBeUndefined();
  });
});

describe('cachedSessionRow', () => {
  test('skips entries that hold no session rows and finds the by-id row', () => {
    const client = new QueryClient();
    // Message authors live under the same prefix and are not rows.
    client.setQueryData(hooks.projectKeys.sessionMessageAuthors('p-1', 's-1'), { authors: {} });
    client.setQueryData(hooks.projectKeys.projectSession('p-1', 's-1'), { session_id: 's-1', name: 'By id' });
    expect(hooks.cachedSessionRow(client, 'p-1', 's-1')).toMatchObject({ name: 'By id' });
    expect(hooks.cachedSessionRow(client, 'p-1', 's-2')).toBeNull();
  });
});
