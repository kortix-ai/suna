import { afterEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { configureKortix } from '../core/http/config';
import type { ProjectSession } from '../core/rest/projects-client';
import { qk } from './query-keys';
import { useProjectSessionPages, useProjectSessionRow } from './use-project-session-pages';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const row = (sessionId: string) => ({ session_id: sessionId, name: sessionId }) as ProjectSession;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

let requests: string[] = [];
let root: ReactTestRenderer | undefined;

function serve(routes: Record<string, unknown>) {
  requests = [];
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });
  globalThis.fetch = mock(async (url: unknown) => {
    const { pathname, search } = new URL(String(url));
    const path = pathname.replace(/^\/v1/, '') + search;
    requests.push(path);
    if (!(path in routes)) return Response.json({ error: `unrouted ${path}` }, { status: 404 });
    return Response.json(routes[path]);
  }) as unknown as typeof fetch;
}

async function mount(client: QueryClient, Probe: () => null) {
  await act(async () => {
    root = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
  });
  await settle();
}

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
});

test('useProjectSessionPages loads one page, then the next page on fetchNextPage', async () => {
  serve({
    '/projects/P1/sessions?limit=50': { sessions: [row('a'), row('b')], next_cursor: 'c1' },
    '/projects/P1/sessions?limit=50&cursor=c1': { sessions: [row('c')], next_cursor: null },
  });
  const client = newClient();
  let result!: ReturnType<typeof useProjectSessionPages>;
  await mount(client, () => {
    result = useProjectSessionPages('P1');
    return null;
  });

  expect(result.data?.map((s) => s.session_id)).toEqual(['a', 'b']);
  expect(result.hasNextPage).toBe(true);
  expect(requests).toEqual(['/projects/P1/sessions?limit=50']);

  await act(async () => { await result.fetchNextPage(); });
  await settle();

  expect(result.data?.map((s) => s.session_id)).toEqual(['a', 'b', 'c']);
  expect(result.hasNextPage).toBe(false);
  expect(requests).toEqual([
    '/projects/P1/sessions?limit=50',
    '/projects/P1/sessions?limit=50&cursor=c1',
  ]);
  client.clear();
});

test('useProjectSessionPages sends the project scope and page size', async () => {
  serve({
    '/projects/P1/sessions?scope=project&limit=20': { sessions: [row('a')], next_cursor: null },
  });
  const client = newClient();
  let result!: ReturnType<typeof useProjectSessionPages>;
  await mount(client, () => {
    result = useProjectSessionPages('P1', { scope: 'project', pageSize: 20 });
    return null;
  });
  expect(result.data?.map((s) => s.session_id)).toEqual(['a']);
  expect(client.getQueryData(qk.project.sessionPages('P1', 'project', 20))).toBeDefined();
  client.clear();
});

test('useProjectSessionRow reads a loaded page and issues no request', async () => {
  serve({});
  const client = newClient();
  client.setQueryData(qk.project.sessionPages('P1'), {
    pages: [{ sessions: [row('a'), row('b')], next_cursor: null }],
    pageParams: [null],
  });
  let session: ProjectSession | undefined;
  await mount(client, () => {
    session = useProjectSessionRow('P1', 'b');
    return null;
  });
  expect(session?.session_id).toBe('b');
  expect(requests).toEqual([]);
  client.clear();
});

test('useProjectSessionRow falls back to the single-session read for an unloaded session', async () => {
  serve({ '/projects/P1/sessions/deep': row('deep') });
  const client = newClient();
  client.setQueryData(qk.project.sessionPages('P1'), {
    pages: [{ sessions: [row('a')], next_cursor: 'c1' }],
    pageParams: [null],
  });
  let session: ProjectSession | undefined;
  await mount(client, () => {
    session = useProjectSessionRow('P1', 'deep');
    return null;
  });
  expect(session?.session_id).toBe('deep');
  expect(requests).toEqual(['/projects/P1/sessions/deep']);
  client.clear();
});

test('useProjectSessionRow follows a list write, such as a rename, without a request', async () => {
  serve({});
  const client = newClient();
  const key = qk.project.sessionPages('P1');
  client.setQueryData(key, { pages: [{ sessions: [row('a')], next_cursor: null }], pageParams: [null] });
  let session: ProjectSession | undefined;
  await mount(client, () => {
    session = useProjectSessionRow('P1', 'a');
    return null;
  });
  expect(session?.name).toBe('a');

  await act(async () => {
    client.setQueryData(key, {
      pages: [{ sessions: [{ ...row('a'), name: 'Renamed' }], next_cursor: null }],
      pageParams: [null],
    });
  });

  expect(session?.name).toBe('Renamed');
  expect(requests).toEqual([]);
  client.clear();
});

test('useProjectSessionRow is undefined and silent when disabled', async () => {
  serve({});
  const client = newClient();
  let session: ProjectSession | undefined = row('sentinel');
  await mount(client, () => {
    session = useProjectSessionRow('P1', 'a', { enabled: false });
    return null;
  });
  expect(session).toBeUndefined();
  expect(requests).toEqual([]);
  client.clear();
});

test('a head refetch (what a poll runs) fetches page 1 only and merges it into the loaded pages', async () => {
  // TanStack runs interval timers only when `window` exists; Bun has none, so
  // this triggers the exact fetch an interval tick would.
  let generation = 0;
  requests = [];
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });
  globalThis.fetch = mock(async (url: unknown) => {
    const { pathname, search } = new URL(String(url));
    const path = pathname.replace(/^\/v1/, '') + search;
    requests.push(path);
    if (path === '/projects/P1/sessions?limit=50') {
      return Response.json(
        generation === 0
          ? { sessions: [row('a'), row('b')], next_cursor: 'c1' }
          : { sessions: [row('new'), row('a')], next_cursor: 'c-new' },
      );
    }
    if (path === '/projects/P1/sessions?limit=50&cursor=c1') {
      return Response.json({ sessions: [row('c')], next_cursor: 'c2' });
    }
    if (path === '/projects/P1/sessions?limit=50&cursor=c2') {
      return Response.json({ sessions: [row('d')], next_cursor: null });
    }
    return Response.json({ error: `unrouted ${path}` }, { status: 404 });
  }) as unknown as typeof fetch;

  const client = newClient();
  let result!: ReturnType<typeof useProjectSessionPages>;
  await mount(client, () => {
    result = useProjectSessionPages('P1', { refetchInterval: () => 60_000 });
    // A list reads these while rendering; TanStack re-renders only on read props.
    void result.data;
    void result.hasNextPage;
    return null;
  });
  await act(async () => { await result.fetchNextPage(); });
  await act(async () => { await result.fetchNextPage(); });
  await settle();
  expect(result.data?.map((s) => s.session_id)).toEqual(['a', 'b', 'c', 'd']);

  requests = [];
  generation = 1;
  await act(async () => {
    await client.refetchQueries({ queryKey: [...qk.project.sessionPages('P1'), 'head'], exact: true });
  });
  await settle();

  expect(requests).toEqual(['/projects/P1/sessions?limit=50']);
  // `b` was pushed past the fresh head's end and is carried; page 2 is untouched.
  expect(result.data?.map((s) => s.session_id)).toEqual(['new', 'a', 'b', 'c', 'd']);
  client.clear();
});

test('the SSE title mirror refetches the page-1 head, never every loaded page', async () => {
  const { refetchKortixSessionMirrors } = await import('./use-opencode-events/helpers');
  serve({
    '/projects/P1/sessions?limit=50': { sessions: [row('a')], next_cursor: 'c1' },
    '/projects/P1/sessions?limit=50&cursor=c1': { sessions: [row('b')], next_cursor: null },
  });
  const client = newClient();
  let result!: ReturnType<typeof useProjectSessionPages>;
  await mount(client, () => {
    result = useProjectSessionPages('P1');
    return null;
  });
  await act(async () => { await result.fetchNextPage(); });
  await settle();

  requests = [];
  await act(async () => {
    refetchKortixSessionMirrors(client, 'P1');
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  expect(requests).toEqual(['/projects/P1/sessions?limit=50']);
  client.clear();
});

test('mounting the head query issues no request of its own', async () => {
  serve({ '/projects/P1/sessions?limit=50': { sessions: [row('a')], next_cursor: 'c1' } });
  const client = newClient();
  await mount(client, () => {
    useProjectSessionPages('P1', { refetchInterval: () => 60_000 });
    return null;
  });
  expect(requests).toEqual(['/projects/P1/sessions?limit=50']);
  client.clear();
});

test('a second surface mounting on stale pages fetches page 1 only, not every loaded page', async () => {
  serve({
    '/projects/P1/sessions?limit=50': { sessions: [row('a')], next_cursor: 'c1' },
    '/projects/P1/sessions?limit=50&cursor=c1': { sessions: [row('b')], next_cursor: 'c2' },
    '/projects/P1/sessions?limit=50&cursor=c2': { sessions: [row('c')], next_cursor: null },
  });
  const client = newClient();
  let sidebar!: ReturnType<typeof useProjectSessionPages>;
  await mount(client, () => {
    sidebar = useProjectSessionPages('P1');
    void sidebar.data;
    return null;
  });
  await act(async () => { await sidebar.fetchNextPage(); });
  await act(async () => { await sidebar.fetchNextPage(); });
  await settle();

  // Everything cached is now stale (the Sessions page opens minutes later).
  for (const query of client.getQueryCache().getAll()) {
    query.setState({ ...query.state, dataUpdatedAt: 0 });
  }
  requests = [];
  let page!: ReturnType<typeof useProjectSessionPages>;
  await act(async () => {
    create(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(() => {
          page = useProjectSessionPages('P1');
          void page.data;
          return null;
        }),
      ),
    );
  });
  await settle();

  expect(page.data?.map((s) => s.session_id)).toEqual(['a', 'b', 'c']);
  expect(requests).toEqual(['/projects/P1/sessions?limit=50']);
  client.clear();
});
