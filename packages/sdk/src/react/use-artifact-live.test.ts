import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { MutationObserver, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureKortix } from '../core/http/config';
import type { ArtifactLiveWebSocket } from '../core/artifact-live/connection';
import { qk } from './query-keys';
import * as react from './index';
import { useArtifactLive } from './use-artifact-live';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
const P = 'project-a';
const A = 'artifact-a';
const USER = '40000000-0000-4000-8000-000000000004';
const THREAD = '30000000-0000-4000-8000-000000000003';

interface Socket { url: string; sent: string[]; closedWith: number | null; open(): void; receive(frame: unknown): void }
let sockets: Socket[];
let tickets: number;
let renderer: ReactTestRenderer | undefined;
let client: QueryClient;
let live: ReturnType<typeof useArtifactLive>;

class FakeSocket {
  url: string;
  sent: string[] = [];
  closedWith: number | null = null;
  private listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }
  send(data: string) { this.sent.push(data); }
  close(code?: number) { this.closedWith = code ?? 1000; }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  open() { for (const listener of this.listeners.get('open') ?? []) listener({}); }
  receive(frame: unknown) { for (const listener of this.listeners.get('message') ?? []) listener({ data: JSON.stringify(frame) }); }
}
const WebSocket = FakeSocket as unknown as ArtifactLiveWebSocket;

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
const participant = (id: string) => ({
  id, who: { kind: 'user', user_id: USER }, name: 'Ada', avatar_url: null, color: 'blue', status: 'viewing', view: 'doc',
  hidden: false, cursor: null, selection: null, typing: null, focus: null,
});

// Every Artifact read the hook may touch, seeded so each one's invalidation can be read back.
const keys = {
  threads: qk.project.artifactComments(P, A, 'open'),
  historicalThreads: qk.project.artifactComments(P, A, 'all', 'commit-old'),
  context: qk.project.artifactCommentContext(P, A, {}),
  screenshot: [...qk.project.artifactComments(P, A), 'screenshot', 'comment-a'],
  activity: qk.project.artifactActivity(P, A, { limit: 20 }),
  activityPages: qk.project.artifactActivityInfinite(P, A, 50),
  detail: qk.project.artifact(P, A, 'current'),
  historicalDetail: qk.project.artifact(P, A, 'commit-old'),
  versions: qk.project.artifactVersions(P, A),
  list: qk.project.artifactList(P, '{}'),
  text: qk.project.artifactText(P, A, 'entry-1'),
  otherThreads: qk.project.artifactComments(P, 'artifact-b', 'open'),
  otherDetail: qk.project.artifact(P, 'artifact-b', 'current'),
} as const;
type Key = keyof typeof keys;
const invalidated = () =>
  (Object.keys(keys) as Key[]).filter((name) => client.getQueryState(keys[name] as readonly unknown[])?.isInvalidated).sort();

beforeEach(() => {
  sockets = [];
  tickets = 0;
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  for (const key of Object.values(keys)) client.setQueryData(key as readonly unknown[], { seeded: true });
  configureKortix({ backendUrl: 'https://artifact-live-hook.example/v1', getToken: async () => 'token' });
  globalThis.fetch = mock(async () => Response.json({ ticket: `ticket-${++tickets}`, expires_at: '2026-11-04T00:01:00Z' })) as unknown as typeof fetch;
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  client.clear();
  globalThis.fetch = originalFetch;
});

async function mount(options: { enabled?: boolean; hidden?: boolean } = {}) {
  let props = { enabled: true, hidden: false, ...options };
  function Probe(current: typeof props) {
    live = useArtifactLive(P, A, { enabled: current.enabled, view: 'doc', version: 'entry-1', hidden: current.hidden, webSocket: WebSocket });
    return null;
  }
  await act(async () => {
    renderer = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe, props)));
  });
  await settle();
  return {
    rerender: async (next: Partial<typeof props>) => {
      props = { ...props, ...next };
      await act(async () => {
        renderer!.update(React.createElement(QueryClientProvider, { client }, React.createElement(Probe, props)));
      });
      await settle();
    },
  };
}

async function welcome() {
  await act(async () => {
    sockets.at(-1)!.open();
    sockets.at(-1)!.receive({ v: 1, t: 'welcome', you: 'conn-1', sends: true });
  });
}

async function server(frame: unknown) {
  await act(async () => { sockets.at(-1)!.receive(frame); });
}

test('useArtifactLive is exported from @kortix/sdk/react', () => {
  expect(react.useArtifactLive).toBe(useArtifactLive);
});

test('disabled, it never opens a connection and reports closed', async () => {
  await mount({ enabled: false });
  expect(sockets).toHaveLength(0);
  expect(tickets).toBe(0);
  expect(live.status).toBe('closed');
  expect(live.participants).toEqual([]);
  expect(live.setCursor(null)).toBe(false);
});

test('enabled, it connects with a fresh ticket and reports status, you and participants', async () => {
  await mount();
  expect(sockets).toHaveLength(1);
  expect(sockets[0]!.url).toBe(`wss://artifact-live-hook.example/v1/projects/${P}/artifacts/${A}/live?ticket=ticket-1`);
  expect(live.status).toBe('connecting');
  await welcome();
  expect(live.status).toBe('live');
  expect(live.you).toBe('conn-1');
  expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ v: 1, t: 'hello', view: 'doc', version: 'entry-1', hidden: false });
  await server({ v: 1, t: 'presence', participants: [participant('conn-1'), participant('conn-2')] });
  expect(live.participants.map((p) => p.id)).toEqual(['conn-1', 'conn-2']);
});

test('changed comments invalidates the comment reads of this Artifact, never its screenshots', async () => {
  await mount();
  await welcome();
  await server({ v: 1, t: 'changed', what: 'comments', version: null });
  expect(invalidated()).toEqual(['context', 'historicalThreads', 'threads']);
});

test('changed activity invalidates the activity reads', async () => {
  await mount();
  await welcome();
  await server({ v: 1, t: 'changed', what: 'activity', version: null });
  expect(invalidated()).toEqual(['activity', 'activityPages']);
});

test('changed content invalidates the current Artifact, its versions and the list; old versions and text are immutable', async () => {
  await mount();
  await welcome();
  await server({ v: 1, t: 'changed', what: 'content', version: 'entry-2' });
  expect(invalidated()).toEqual(['detail', 'list', 'versions']);
});

test('resync after a reconnect invalidates every read once', async () => {
  await mount();
  await welcome();
  expect(invalidated()).toEqual([]);
  await act(async () => {
    for (const listener of (sockets[0] as unknown as { listeners: Map<string, Array<(event: unknown) => void>> }).listeners.get('close') ?? []) {
      listener({ code: 1006 });
    }
  });
  expect(live.status).toBe('reconnecting');
  // The first retry waits 1 s plus up to 50 % jitter on the real clock.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_600)); });
  expect(sockets).toHaveLength(2);
  expect(tickets).toBe(2);
  await welcome();
  expect(live.status).toBe('live');
  expect(invalidated()).toEqual(['activity', 'activityPages', 'context', 'detail', 'historicalThreads', 'list', 'threads', 'versions']);
});

test('a comment write in flight defers the comments refetch to the write itself', async () => {
  await mount();
  await welcome();
  const write = new MutationObserver(client, { mutationKey: ['artifact-comment-write', P, A], mutationFn: () => new Promise(() => {}) });
  void write.mutate();
  await settle();
  await server({ v: 1, t: 'changed', what: 'comments', version: null });
  expect(invalidated()).toEqual([]);
});

test('setters reach the socket, and hidden follows the option', async () => {
  const view = await mount();
  await welcome();
  expect(live.setFocus(THREAD)).toBe(true);
  await settle();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
  await view.rerender({ hidden: true });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
  expect(sockets[0]!.sent.map((raw) => JSON.parse(raw))).toEqual([
    { v: 1, t: 'hello', view: 'doc', version: 'entry-1', hidden: false },
    { v: 1, t: 'focus', thread_id: THREAD },
    { v: 1, t: 'hide', hidden: true },
  ]);
});

test('unmount and disable both close the connection', async () => {
  const view = await mount();
  await welcome();
  await view.rerender({ enabled: false });
  expect(sockets[0]!.closedWith).toBe(1000);
  expect(JSON.parse(sockets[0]!.sent.at(-1)!)).toEqual({ v: 1, t: 'bye' });
  expect(live.status).toBe('closed');
  await view.rerender({ enabled: true });
  expect(sockets).toHaveLength(2);
  await act(async () => renderer!.unmount());
  renderer = undefined;
  expect(sockets[1]!.closedWith).toBe(1000);
});
