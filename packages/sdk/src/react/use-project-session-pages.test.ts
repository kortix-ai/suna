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
