import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureKortix } from '../core/http/config';
import type { ProjectSessionGroup } from '../core/rest/projects-client/session-groups';
import type { ProjectSession } from '../core/rest/projects-client/sessions';
import { qk } from './query-keys';
import {
  useCreateProjectSessionGroup,
  useDeleteProjectSessionGroup,
  useProjectSessionGroups,
  useRenameProjectSessionGroup,
  useReorderProjectSessionGroups,
  useSetProjectSessionGroup,
} from './use-session-groups';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Session groups (`session_groups`): the project's shared folders of sessions.
// Reordering and filing show at once; the server's answer replaces the guess,
// and a refusal puts the server's state back.

function group(id: string, position: number): ProjectSessionGroup {
  return { group_id: id, name: `Store ${id}`, position, created_by: null, created_at: '2026-10-27T00:00:00.000Z', updated_at: '2026-10-27T00:00:00.000Z' };
}
function row(sessionId: string, groupId: string | null = null): ProjectSession {
  return { session_id: sessionId, group_id: groupId } as ProjectSession;
}

const groupsKey = qk.project.sessionGroups('P1');
const listKey = qk.project.sessionsPaged('P1', 'visible', { parent: 'root', group: 'none' });

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
        path: `${u.pathname}${u.search}`,
        body,
        respond: (status, payload) => resolve(Response.json(payload, { status })),
      });
    });
  }) as unknown as typeof fetch;
});

let renderer: ReactTestRenderer | null = null;
let client: QueryClient;
let api: {
  groups: ReturnType<typeof useProjectSessionGroups>;
  create: ReturnType<typeof useCreateProjectSessionGroup>;
  rename: ReturnType<typeof useRenameProjectSessionGroup>;
  remove: ReturnType<typeof useDeleteProjectSessionGroup>;
  reorder: ReturnType<typeof useReorderProjectSessionGroups>;
  file: ReturnType<typeof useSetProjectSessionGroup>;
};

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  client?.clear();
});

function Probe({ enabled }: { enabled: boolean }) {
  api = {
    groups: useProjectSessionGroups('P1', { enabled }),
    create: useCreateProjectSessionGroup('P1'),
    rename: useRenameProjectSessionGroup('P1'),
    remove: useDeleteProjectSessionGroup('P1'),
    reorder: useReorderProjectSessionGroups('P1'),
    file: useSetProjectSessionGroup('P1'),
  };
  return null;
}

async function mount(opts: { enabled?: boolean; seed?: boolean } = {}) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (opts.seed !== false) {
    client.setQueryData(groupsKey, [group('A', 0), group('B', 1), group('C', 2)]);
    client.setQueryData(listKey, { pages: [{ items: [row('S1'), row('S2')], next_cursor: null }], pageParams: [null] });
  }
  await act(async () => {
    renderer = create(
      React.createElement(QueryClientProvider, { client }, React.createElement(Probe, { enabled: opts.enabled ?? true })),
    );
  });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

const cachedOrder = () => client.getQueryData<ProjectSessionGroup[]>(groupsKey)!.map((g) => g.group_id);
const cachedRow = (sessionId: string) =>
  client.getQueryData<{ pages: Array<{ items: ProjectSession[] }> }>(listKey)!.pages[0]!.items.find((r) => r.session_id === sessionId)!;
const requests = () => held.map((h) => `${h.method} ${h.path}`);

test('useProjectSessionGroups reads nothing while disabled (the flag is off) and GETs the groups once enabled', async () => {
  await mount({ enabled: false, seed: false });
  await settle();
  expect(held).toEqual([]);
  await act(async () => renderer!.update(React.createElement(QueryClientProvider, { client }, React.createElement(Probe, { enabled: true }))));
  await settle();
  expect(requests()).toEqual(['GET /projects/P1/session-groups']);
  await act(async () => held[0]!.respond(200, { groups: [group('A', 0)] }));
  await settle();
  expect(api.groups.data?.map((g) => g.group_id)).toEqual(['A']);
});

test('reorder shows the new order at once, then keeps the server answer', async () => {
  await mount();
  let done!: Promise<unknown>;
  await act(async () => {
    done = api.reorder.mutateAsync(['C', 'A', 'B']);
  });
  await settle();
  expect(requests()).toEqual(['PUT /projects/P1/session-groups/order']);
  expect(held[0]!.body).toEqual({ group_ids: ['C', 'A', 'B'] });
  expect(cachedOrder()).toEqual(['C', 'A', 'B']);
  await act(async () => {
    held[0]!.respond(200, { groups: [group('C', 0), group('A', 1), group('B', 2)] });
    await done;
  });
  expect(client.getQueryData<ProjectSessionGroup[]>(groupsKey)!.map((g) => g.position)).toEqual([0, 1, 2]);
});

test('a refused reorder (409 group_order_stale) puts the old order back and reads the list again', async () => {
  await mount();
  let failed!: Promise<unknown>;
  await act(async () => {
    failed = api.reorder.mutateAsync(['C', 'A', 'B']).catch((e: unknown) => e);
  });
  await settle();
  await act(async () => {
    held[0]!.respond(409, { error: 'The group list changed.', code: 'group_order_stale' });
    await failed;
  });
  await settle();
  expect(cachedOrder()).toEqual(['A', 'B', 'C']);
  expect(requests()).toContain('GET /projects/P1/session-groups');
});

test('filing shows the new group_id at once and takes the row out of the no-group list, then refetches the session lists', async () => {
  await mount();
  const own = qk.project.session('P1', 'S1');
  client.setQueryData(own, row('S1'));
  let done!: Promise<unknown>;
  await act(async () => {
    done = api.file.mutateAsync({ sessionId: 'S1', groupId: 'A' });
  });
  await settle();
  expect(requests()).toEqual(['PUT /projects/P1/sessions/S1/group']);
  expect(held[0]!.body).toEqual({ group_id: 'A' });
  expect(client.getQueryData<ProjectSession>(own)!.group_id).toBe('A');
  expect(cachedRow('S1')).toBeUndefined();
  expect(cachedRow('S2').group_id).toBeNull();
  await act(async () => {
    held[0]!.respond(200, { session_id: 'S1', group_id: 'A' });
    await done;
  });
  await settle();
  expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
});

test('filing moves the row between the cached group lists at once: out of its old list, into the new one', async () => {
  await mount();
  const groupA = qk.project.sessionsPaged('P1', 'visible', { group: 'A' });
  const groupB = qk.project.sessionsPaged('P1', 'visible', { group: 'B' });
  client.setQueryData(groupA, { pages: [{ items: [row('S3', 'A')], next_cursor: null }], pageParams: [null] });
  client.setQueryData(groupB, { pages: [{ items: [], next_cursor: null }], pageParams: [null] });
  const ids = (key: readonly unknown[]) =>
    client.getQueryData<{ pages: Array<{ items: ProjectSession[] }> }>(key)!.pages.flatMap((p) => p.items.map((r) => r.session_id));

  await act(async () => {
    void api.file.mutateAsync({ sessionId: 'S3', groupId: 'B' }).catch(() => undefined);
    void api.file.mutateAsync({ sessionId: 'S2', groupId: 'A' }).catch(() => undefined);
  });
  await settle();
  expect(ids(groupA)).toEqual(['S2']);
  expect(ids(groupB)).toEqual(['S3']);
  expect(ids(listKey)).toEqual(['S1']);
  expect(cachedRow('S1').group_id).toBeNull();
});

/**
 * Start a mutation, answer its request, then answer the groups refetch it
 * waits for (the hooks resolve once the list holds the change).
 */
async function answer(start: () => Promise<unknown>, status: number, body: unknown) {
  let done!: Promise<unknown>;
  await act(async () => {
    done = start();
  });
  await settle();
  await act(async () => held[0]!.respond(status, body));
  await settle();
  await act(async () => {
    for (const request of held.slice(1)) request.respond(200, { groups: [group('B', 0)] });
    await done;
  });
}

test('create, rename and delete each read the groups again; delete also marks the session lists stale', async () => {
  await mount();
  await answer(() => api.create.mutateAsync({ name: 'Store D' }), 201, group('D', 3));
  expect(requests()).toEqual(['POST /projects/P1/session-groups', 'GET /projects/P1/session-groups']);
  expect(held[0]!.body).toEqual({ name: 'Store D' });
  held.length = 0;

  await answer(() => api.rename.mutateAsync({ groupId: 'A', name: 'Store A (EU)' }), 200, { ...group('A', 0), name: 'Store A (EU)' });
  expect(requests()).toEqual(['PATCH /projects/P1/session-groups/A', 'GET /projects/P1/session-groups']);
  expect(held[0]!.body).toEqual({ name: 'Store A (EU)' });
  held.length = 0;

  await answer(() => api.remove.mutateAsync('A'), 200, { ok: true });
  expect(requests()).toEqual(['DELETE /projects/P1/session-groups/A', 'GET /projects/P1/session-groups']);
  expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
});
