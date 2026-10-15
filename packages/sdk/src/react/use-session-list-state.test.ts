import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureKortix } from '../core/http/config';
import type { ProjectSession } from '../core/rest/projects-client/sessions';
import { qk } from './query-keys';
import { useSessionListState } from './use-session-list-state';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// KRTX-2418: one hook pins or archives a session for the caller. Every cached
// list shows the change at once; the server's answer then replaces it, and the
// lists refetch, so an archived row leaves the list and enters the archive.

const PINNED_AT = '2026-10-15T10:00:00.000Z';
const listKey = qk.project.sessionsPaged('P1');

function row(sessionId: string): ProjectSession {
  return { session_id: sessionId, pinned_at: null, archived_at: null } as ProjectSession;
}

let held: Array<{ method: string; path: string; body: unknown; respond: (status: number, body: unknown) => void }>;

beforeEach(() => {
  held = [];
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  globalThis.fetch = mock((url: unknown, init: RequestInit = {}) => {
    const u = new URL(String(url));
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    return new Promise<Response>((resolve) => {
      held.push({
        method: init.method ?? 'GET',
        path: u.pathname,
        body,
        respond: (status, payload) => resolve(Response.json(payload, { status })),
      });
    });
  }) as unknown as typeof fetch;
});

let renderer: ReactTestRenderer | null = null;
let client: QueryClient;
let api: ReturnType<typeof useSessionListState>;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  client?.clear();
});

function Probe() {
  api = useSessionListState('P1');
  return null;
}

async function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(listKey, { pages: [{ items: [row('S1'), row('S2')], next_cursor: null }], pageParams: [null] });
  await act(async () => {
    renderer = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
  });
}

const cached = (sessionId: string) =>
  client.getQueryData<{ pages: Array<{ items: ProjectSession[] }> }>(listKey)!.pages[0]!.items.find((r) => r.session_id === sessionId)!;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

test('setPinned shows the pin at once, then the server state, then invalidates the lists', async () => {
  await mount();
  let done!: Promise<unknown>;
  await act(async () => {
    done = api.setPinned('S1', true);
  });
  await settle();
  expect(held.map((h) => `${h.method} ${h.path}`)).toEqual(['PUT /projects/P1/sessions/S1/pin']);
  expect(held[0]!.body).toEqual({ pinned: true });
  expect(cached('S1').pinned_at).toBeTruthy();
  expect(cached('S1').archived_at).toBeNull();
  expect(cached('S2').pinned_at).toBeNull();
  await act(async () => {
    held[0]!.respond(200, { pinned_at: PINNED_AT, archived_at: null });
    await done;
  });
  expect(cached('S1').pinned_at).toBe(PINNED_AT);
  expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
});

test('setArchived archives and unpins at once; a refusal rejects and the lists refetch', async () => {
  await mount();
  client.setQueryData(listKey, { pages: [{ items: [{ ...row('S1'), pinned_at: PINNED_AT }], next_cursor: null }], pageParams: [null] });
  let done!: Promise<unknown>;
  await act(async () => {
    done = api.setArchived('S1', true).catch((error: unknown) => error);
  });
  await settle();
  expect(held[0]!.body).toEqual({ archived: true });
  expect(cached('S1').archived_at).toBeTruthy();
  expect(cached('S1').pinned_at).toBeNull();
  await act(async () => {
    held[0]!.respond(403, { error: 'Only a person can pin or archive a session' });
    expect(await done).toBeTruthy();
  });
  expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
});
