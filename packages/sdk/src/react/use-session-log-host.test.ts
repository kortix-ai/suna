import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { setRuntimeCapabilities } from '../browser/stores/sandbox-connection-store';
import { configureKortix } from '../core/http/config';
import { setCurrentRuntime } from '../core/session/current-runtime';
import { sessionStartKey, type SessionStartResult } from '../core/rest/projects-client';
import { useSession } from './opencode';
import { useSessionLogThread } from './use-session-log';
import { qk } from './query-keys';
import { resetSessionOpenBundles } from '../core/session/open-bundle';
import type { SessionLog, SessionLogThread } from '../core/session-log/types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const log: SessionLog = JSON.parse(readFileSync(join(import.meta.dir, '../../../api-contract/src/__tests__/fixtures/session-log/golden21.v2.json'), 'utf8'));
const page = () => {
  const { threads, ...session } = structuredClone(log);
  return { session, generation: 1, threads: threads.map(({ messages: _m, ...head }) => head), thread_id: threads[0]!.thread_id, messages: threads[0]!.messages, has_more: false };
};

/**
 * A host that reads its own transcript (`chatEngine: false`, apps/mobile) still renders the
 * session log: `useSession` negotiates it, so `useSessionLogThread` serves v2 records once the
 * runtime lists `session.log.v2` and the project flag `session_log` is on.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT_ID = '00000000-0000-4000-8000-0000000000c1';
const SESSION_ID = 'kses_log_host';

let urls: string[];
let serveLog = false;
let pagedLog = false;
let emptyLog = false;
/** The project's detail never answers: its features (the `session_log` flag) stay unknown. */
let detailPending = false;
/** `GET …/log` answers 404 `session_log_missing`: an API that serves the log, a session with none yet. */
let missingLog = false;
let renderer: ReactTestRenderer | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  urls = [];
  serveLog = false;
  pagedLog = false;
  emptyLog = false;
  detailPending = false;
  missingLog = false;
  setCurrentRuntime(null);
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  globalThis.fetch = mock(async (url: unknown) => {
    const parsed = new URL(url instanceof Request ? url.url : String(url));
    const path = parsed.pathname;
    urls.push(path + parsed.search);
    if (missingLog && path.endsWith('/log')) return Response.json({ error: 'No session log for this session', code: 'session_log_missing' }, { status: 404 });
    if (serveLog && path.endsWith('/log')) {
      if (emptyLog) return Response.json({ ...page(), messages: [], has_more: false });
      if (!pagedLog) return Response.json(page());
      // Paged: the newest page holds all but the first four messages.
      const before = parsed.searchParams.get('before_seq');
      const all = page();
      return Response.json(before === null ? { ...all, messages: all.messages.slice(4), has_more: true } : { ...all, messages: all.messages.slice(0, 4), has_more: false });
    }
    // The session stream: an open SSE body that never ends.
    if (serveLog && path.endsWith('/events')) return new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } });
    // The turn record of a session that never ran a turn.
    if (emptyLog && path.endsWith('/turn')) return Response.json({ turns: [], last_ended: null });
    if (path === `/projects/${PROJECT_ID}/detail` && detailPending) return new Promise<Response>(() => {});
    if (path === `/projects/${PROJECT_ID}/detail`) return Response.json({ project: { project_id: PROJECT_ID, experimental: { session_log: true } }, config: {} });
    return Response.json({}, { status: 404 });
  }) as unknown as typeof fetch;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  queryClient.clear();
  setRuntimeCapabilities(null);
});

const flush = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); });

describe('useSession negotiates the session log without its chat engine', () => {
  test.each([true, false])('chatEngine %p: the first log page is requested', async (chatEngine) => {
    function Host() {
      useSession(PROJECT_ID, SESSION_ID, { chatEngine, replayStartStash: false });
      return null;
    }
    act(() => {
      renderer = create(createElement(QueryClientProvider, { client: queryClient }, createElement(Host)));
    });
    // The runtime's health answer lists the log (a box switch clears the list first).
    act(() => setRuntimeCapabilities(['session.log.v2']));
    await flush();
    expect(urls.some((u) => u.startsWith(`/projects/${PROJECT_ID}/sessions/${SESSION_ID}/log`))).toBe(true);
  });

  test.each([true, false])('chatEngine false, flag %p known at the open: the snapshot asks no transcript window', async (flag) => {
    // The open reads the log first, whatever the flag: the snapshot's v1 window is never read.
    resetSessionOpenBundles();
    queryClient.setQueryData(qk.project.detail(PROJECT_ID), { project: { project_id: PROJECT_ID, experimental: { session_log: flag } }, config: {} });
    function Host() {
      useSession(PROJECT_ID, SESSION_ID, { chatEngine: false, replayStartStash: false });
      return null;
    }
    act(() => {
      renderer = create(createElement(QueryClientProvider, { client: queryClient }, createElement(Host)));
    });
    await flush();
    const snapshots = urls.filter((u) => u.includes('/snapshot'));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toContain('transcript=0');
  });

  test('disabled: no log request', async () => {
    function Host() {
      useSession(PROJECT_ID, SESSION_ID, { enabled: false, chatEngine: false, replayStartStash: false });
      return null;
    }
    act(() => {
      renderer = create(createElement(QueryClientProvider, { client: queryClient }, createElement(Host)));
    });
    act(() => setRuntimeCapabilities(['session.log.v2']));
    await flush();
    expect(urls.filter((u) => u.includes('/log'))).toEqual([]);
  });

  test('chatEngine false: with a page served, the session stream switches to schema=v2 and useSessionLogThread returns the v2 records', async () => {
    serveLog = true;
    // A ready box (a fresh ready answer is served from cache): the runtime stream joins, and carries the log.
    queryClient.setQueryData(sessionStartKey(PROJECT_ID, SESSION_ID), {
      stage: 'ready', agent_name: 'default', retriable: false, reason: 'unchanged', opencode_session_id: 'ses_log_host', runtime_url: '/p/sbx_log/8000',
      sandbox: { sandbox_id: SESSION_ID, session_id: SESSION_ID, project_id: PROJECT_ID, account_id: 'acct', provider: 'platinum', external_id: 'sbx_log', base_url: null, status: 'active', config: {}, metadata: {}, last_used_at: null, created_at: '2026-10-14T00:00:00Z', updated_at: '2026-10-14T00:00:00Z' },
    } as unknown as SessionStartResult);
    const seen: { thread: SessionLogThread | null } = { thread: null };
    function Host() {
      useSession(PROJECT_ID, SESSION_ID, { chatEngine: false, replayStartStash: false });
      seen.thread = useSessionLogThread({ projectId: PROJECT_ID, sessionId: SESSION_ID, runtimeSessionId: null });
      return null;
    }
    act(() => {
      renderer = create(createElement(QueryClientProvider, { client: queryClient }, createElement(Host)));
    });
    act(() => setRuntimeCapabilities(['session.log.v2']));
    await flush();
    // The stream reconnects with `schema=v2` once the page lands.
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect(urls.some((u) => u.includes(`/sessions/${SESSION_ID}/events`) && u.includes('schema=v2'))).toBe(true);
    expect(seen.thread?.thread_id).toBe(log.threads[0]!.thread_id);
    expect(seen.thread?.messages.map((m) => m.message_id)).toEqual(log.threads[0]!.messages.map((m) => m.message_id));
  });
});

describe('useSession with its chat engine: the session log owns the history once session_log is on', () => {
  type Result = ReturnType<typeof useSession>;
  function mountHost(flag: boolean) {
    // The project shell has read the project detail: the flag is known at the first render.
    queryClient.setQueryData(qk.project.detail(PROJECT_ID), { project: { project_id: PROJECT_ID, experimental: { session_log: flag } }, config: {} });
    const seen: { result: Result | null } = { result: null };
    function Host() {
      seen.result = useSession(PROJECT_ID, SESSION_ID, { replayStartStash: false });
      return null;
    }
    act(() => {
      renderer = create(createElement(QueryClientProvider, { client: queryClient }, createElement(Host)));
    });
    return seen;
  }

  test('no saved-copy read: no /transcript request; the log page paints', async () => {
    serveLog = true;
    pagedLog = true;
    const seen = mountHost(true);
    await flush();
    const base = `/projects/${PROJECT_ID}/sessions/${SESSION_ID}`;
    expect(urls.filter((u) => u.includes('/transcript'))).toEqual([]);
    expect(urls).toContain(`${base}/log?limit=40`);
    expect(seen.result!.savedTranscript).toBe('shown');
    expect(seen.result!.hasOlder).toBe(true);
  });

  test('loadOlder reads GET …/log?thread=&before_seq= and the thread is whole after it', async () => {
    serveLog = true;
    pagedLog = true;
    const seen = mountHost(true);
    await flush();
    const root = log.threads[0]!;
    await act(async () => { await seen.result!.loadOlder(); });
    await flush();
    expect(urls).toContain(`/projects/${PROJECT_ID}/sessions/${SESSION_ID}/log?thread=${root.thread_id}&before_seq=${root.messages[4]!.seq}&limit=100`);
    expect(urls.filter((u) => u.includes('/transcript'))).toEqual([]);
    expect(seen.result!.hasOlder).toBe(false);
  });

  test('a stored log with an empty root thread proves the conversation empty: the composer, not the boot screen', async () => {
    serveLog = true;
    emptyLog = true;
    const seen = mountHost(true);
    await flush();
    expect(urls.filter((u) => u.includes('/transcript'))).toEqual([]);
    expect(seen.result!.savedTranscript).toBe('none');
    expect(seen.result!.conversationEmpty).toBe(true);
  });

  test('a cold open (the project features not loaded) reads GET …/log first and sends no /transcript', async () => {
    serveLog = true;
    detailPending = true;
    const seen: { result: Result | null } = { result: null };
    function Host() {
      seen.result = useSession(PROJECT_ID, SESSION_ID, { replayStartStash: false });
      return null;
    }
    act(() => {
      renderer = create(createElement(QueryClientProvider, { client: queryClient }, createElement(Host)));
    });
    await flush();
    const base = `/projects/${PROJECT_ID}/sessions/${SESSION_ID}`;
    expect(urls.filter((u) => u.includes('/transcript'))).toEqual([]);
    expect(urls).toContain(`${base}/log?limit=40`);
    // The snapshot asks no v1 window either.
    expect(urls.filter((u) => u.includes('/snapshot')).every((u) => u.includes('transcript=0'))).toBe(true);
    expect(seen.result!.savedTranscript).toBe('shown');
  });

  test('a new session on an API that serves the log (404 session_log_missing): no /transcript, and nothing saved to wait for', async () => {
    missingLog = true;
    const seen = mountHost(true);
    await flush();
    const base = `/projects/${PROJECT_ID}/sessions/${SESSION_ID}`;
    expect(urls).toContain(`${base}/log?limit=40`);
    expect(urls.filter((u) => u.includes('/transcript'))).toEqual([]);
    expect(seen.result!.savedTranscript).toBe('none');
  });

  test.each([true, false])('flag %p: a server older than the log (GET …/log answers 404) falls back to the v1 saved copy', async (flag) => {
    mountHost(flag);
    await flush();
    const base = `/projects/${PROJECT_ID}/sessions/${SESSION_ID}`;
    expect(urls).toContain(`${base}/log?limit=40`);
    expect(urls).toContain(`${base}/transcript?shape=sync&limit=40&history=true`);
    // The log is asked first.
    expect(urls.indexOf(`${base}/log?limit=40`)).toBeLessThan(urls.indexOf(`${base}/transcript?shape=sync&limit=40&history=true`));
  });
});
