import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { SessionLog } from '../core/session-log/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Synthetic values only. The page comes from the api-contract golden fixture.

// The API's session log route, answered by hand.
let loads: Array<{ projectId: string; sessionId: string; query: unknown }> = [];
let answer: () => Promise<unknown> = async () => page();
const realSource = await import('../core/session-log/source');
mock.module('../core/session-log/source', () => ({
  ...realSource,
  loadSessionLogPage: async (projectId: string, sessionId: string, query: unknown) => {
    loads.push({ projectId, sessionId, query });
    return answer();
  },
}));

// The API's session stream, joined by hand.
let joined: Array<{ options: Record<string, unknown>; closed: boolean }> = [];
const realStream = await import('../core/session/control-stream');
mock.module('../core/session/control-stream', () => ({
  ...realStream,
  openSessionStream: (options: Record<string, unknown>) => {
    const entry = { options, closed: false };
    joined.push(entry);
    return { close: () => void (entry.closed = true) };
  },
}));

// The one global runtime pointer: a view never moves it.
let runtimeSwitches: unknown[] = [];
const realRuntime = await import('../core/session/current-runtime');
mock.module('../core/session/current-runtime', () => ({
  ...realRuntime,
  setCurrentRuntime: (...args: unknown[]) => {
    runtimeSwitches.push(args);
    return realRuntime.setCurrentRuntime(...(args as Parameters<typeof realRuntime.setCurrentRuntime>));
  },
}));

const { useSyncStore } = await import('../browser/stores/sync-store');
const { setSavedCopyStore } = await import('../core/session-sync/saved-copy-store');
const { useSessionView } = await import('./use-session-view');

const log: SessionLog = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../api-contract/src/__tests__/fixtures/session-log/golden21.v2.json'), 'utf8'),
);
const PROJECT = 'proj_view';
const CHILD = 'kses_child';
function page(messages = true) {
  const { threads, ...session } = structuredClone(log);
  return {
    session,
    generation: 1,
    threads: threads.map(({ messages: _m, ...head }) => head),
    thread_id: threads[0]!.thread_id,
    messages: messages ? threads[0]!.messages : [],
    has_more: false,
  };
}
const failure = (status: number, code?: string) => Object.assign(new Error(`HTTP ${status}`), { status, code: code ?? String(status) });
const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });

let renderer: ReactTestRenderer | null = null;
let fetches: string[] = [];
const realFetch = globalThis.fetch;
type View = ReturnType<typeof useSessionView>;
function mount(options?: Parameters<typeof useSessionView>[2]) {
  const seen: { view: View | null } = { view: null };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Probe(): ReactNode {
    seen.view = useSessionView(PROJECT, CHILD, options);
    return null;
  }
  act(() => {
    renderer = create(createElement(QueryClientProvider, { client }, createElement(Probe)));
  });
  return seen;
}

beforeEach(() => {
  useSyncStore.getState().reset();
  setSavedCopyStore(null);
  loads = [];
  joined = [];
  runtimeSwitches = [];
  fetches = [];
  answer = async () => page();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetches.push(String(input));
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  globalThis.fetch = realFetch;
});

describe('useSessionView: a read-only view of a session, from the API alone', () => {
  test("reads the session's own log and joins its stream; it never starts the session and never moves the runtime", async () => {
    const seen = mount();
    expect(seen.view!.status).toBe('loading');
    await flush();
    expect(loads).toEqual([{ projectId: PROJECT, sessionId: CHILD, query: expect.objectContaining({ limit: expect.any(Number) }) }]);
    expect(seen.view!.status).toBe('ready');
    expect(seen.view!.thread!.thread_id).toBe(log.threads[0]!.thread_id);
    expect(seen.view!.thread!.messages).toEqual(log.threads[0]!.messages);
    expect(seen.view).toMatchObject({ projectId: PROJECT, sessionId: CHILD });
    // Live: the session stream on the v2 schema, keyed by this session.
    expect(joined.at(-1)!.options).toMatchObject({ projectId: PROJECT, sessionId: CHILD, schema: 'v2' });
    // No `/start` and no other request outside the log route; the global runtime stays where it was.
    expect(fetches).toEqual([]);
    expect(runtimeSwitches).toEqual([]);
  });

  test('a session with no log yet is empty, and so is a log whose root thread has no message', async () => {
    answer = async () => {
      throw failure(404, 'session_log_missing');
    };
    const missing = mount();
    await flush();
    expect(missing.view!.status).toBe('empty');
    expect(missing.view!.thread).toBeNull();
    act(() => renderer?.unmount());

    answer = async () => page(false);
    const blank = mount();
    await flush();
    expect(blank.view!.status).toBe('empty');
  });

  test('a failed read is an error; retry reads the log again', async () => {
    answer = async () => {
      throw failure(500);
    };
    const seen = mount();
    await flush();
    expect(seen.view!.status).toBe('error');
    answer = async () => page();
    act(() => seen.view!.retry());
    await flush();
    expect(loads.length).toBeGreaterThanOrEqual(2);
    expect(seen.view!.status).toBe('ready');
  });

  test('disabled: no read and no stream', async () => {
    const seen = mount({ enabled: false });
    await flush();
    expect(loads).toEqual([]);
    expect(joined).toEqual([]);
    expect(seen.view!.status).toBe('loading');
  });

  test('unmounting closes the stream and drops the log from the store', async () => {
    mount();
    await flush();
    expect(useSyncStore.getState().sessionLogs[CHILD]).toBeDefined();
    act(() => renderer?.unmount());
    renderer = null;
    expect(joined.every((entry) => entry.closed)).toBe(true);
    expect(useSyncStore.getState().sessionLogs[CHILD]).toBeUndefined();
  });
});
