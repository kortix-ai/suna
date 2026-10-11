import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { SessionLog } from '../core/session-log/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The project detail answers the `session_log` flag; no network runs.
let flag: boolean | undefined = true;
const detailCalls: string[] = [];
mock.module('../core/rest/projects-client', () => ({
  getProjectDetail: async (projectId: string) => {
    detailCalls.push(projectId);
    return { project: { project_id: projectId, experimental: flag === undefined ? undefined : { session_log: flag } } };
  },
}));

const { useSyncStore } = await import('../browser/stores/sync-store');
const { setRuntimeCapabilities } = await import('../browser/stores/sandbox-connection-store');
const { useSessionLog, useSessionLogSync, useSessionLogThread } = await import('./use-session-log');
const { createSavedCopyStore, setSavedCopyStore } = await import('../core/session-sync/saved-copy-store');
const { savedSessionLogCopies } = await import('../core/session-log/saved-log');

const log: SessionLog = JSON.parse(readFileSync(join(import.meta.dir, '../../../api-contract/src/__tests__/fixtures/session-log/golden21.v2.json'), 'utf8'));
const PROJECT = 'proj_log';
const SESSION = 'kses_log';
const page = () => {
  const { threads, ...session } = structuredClone(log);
  return { session, generation: 1, threads: threads.map(({ messages: _m, ...head }) => head), thread_id: threads[0]!.thread_id, messages: threads[0]!.messages, has_more: false };
};
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });

let renderer: ReactTestRenderer | null = null;
function render(node: () => ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Probe() {
    return node() as never;
  }
  act(() => {
    renderer = create(createElement(QueryClientProvider, { client }, createElement(Probe)));
  });
}

beforeEach(() => {
  useSyncStore.getState().reset();
  setRuntimeCapabilities(['session.rewind', 'session.log.v2']);
  flag = true;
  detailCalls.length = 0;
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  setRuntimeCapabilities(null);
});

describe('useSessionLog / useSessionLogThread', () => {
  test('null while the session reads v1; the records once a page is in the store', () => {
    const seen: Array<{ log: SessionLog | null; root: unknown; child: unknown }> = [];
    render(() => {
      const session = { projectId: PROJECT, sessionId: SESSION };
      seen.push({ log: useSessionLog(session), root: useSessionLogThread(session), child: useSessionLogThread(session, log.threads[1]!.thread_id) });
      return null;
    });
    expect(seen.at(-1)).toEqual({ log: null, root: null, child: null });
    act(() => useSyncStore.getState().applySessionLogPage(SESSION, page()));
    const last = seen.at(-1)!;
    expect(last.log!.session_id).toBe(log.session_id);
    expect(last.log!.threads[0]!.messages).toEqual(log.threads[0]!.messages);
    expect(last.root).toBe(last.log!.threads[0]!);
    expect(last.child).toBe(last.log!.threads[1]!);
  });
});

describe('useSessionLogSync: negotiation, the first page and the stream', () => {
  type Joined = { options: Record<string, any>; closed: boolean };
  let joined: Joined[] = [];
  const joinStream = (options: Record<string, any>) => {
    const entry: Joined = { options, closed: false };
    joined.push(entry);
    return { close: () => { entry.closed = true; } };
  };
  beforeEach(() => {
    joined = [];
    setSavedCopyStore(null);
  });
  const v1Page = () => {
    const p = page();
    for (const t of p.threads) t.ext = { opencode: { version: 'kortix.transcript.v1', native_id: t.thread_id } };
    return p;
  };
  function mount(options: { enabled?: boolean; loader?: ((...a: unknown[]) => Promise<unknown>) | null }) {
    const state = { dialect: '' };
    render(() => {
      state.dialect = useSessionLogSync(PROJECT, SESSION, { enabled: options.enabled ?? true, loader: options.loader as never, joinStream: joinStream as never });
      return null;
    });
    return state;
  }

  test('v2 on a fromV1 thread: the page goes in the store, the stream switches to schema v2, and unmount drops both', async () => {
    const calls: unknown[][] = [];
    const state = mount({ loader: async (...args) => { calls.push(args.slice(0, 3)); return v1Page(); } });
    await flush();
    expect(state.dialect).toBe('v2');
    expect(calls).toEqual([[PROJECT, SESSION, { limit: 40 }]]);
    expect(useSyncStore.getState().sessionLogs[SESSION]!.session.session_id).toBe(log.session_id);
    expect(joined.map((j) => [j.options.projectId, j.options.sessionId, j.options.schema])).toEqual([[PROJECT, SESSION, 'v2']]);
    act(() => renderer?.unmount());
    renderer = null;
    expect(useSyncStore.getState().sessionLogs[SESSION]).toBeUndefined();
    expect(joined[0]!.closed).toBe(true);
  });

  test('a stream reconnect re-reads the first page (frames in the gap are not replayed)', async () => {
    let calls = 0;
    mount({ loader: async () => { calls++; return v1Page(); } });
    await flush();
    act(() => joined[0]!.options.onConnectionChange(true));
    await flush();
    expect(calls).toBe(1);
    act(() => joined[0]!.options.onConnectionChange(false));
    act(() => joined[0]!.options.onConnectionChange(true));
    await flush();
    expect(calls).toBe(2);
  });

  test('a thread without the kortix.transcript.v1 ext (pi): v1, no session log, no schema v2', async () => {
    const state = mount({ loader: async () => page() });
    await flush();
    expect(state.dialect).toBe('v1');
    expect(useSyncStore.getState().sessionLogs).toEqual({});
    expect(joined).toEqual([]);
  });

  test('a pi page touches no device copy: no v2 copy is written and the v1 copy stays', async () => {
    const data = new Map<string, string>();
    const store = createSavedCopyStore({ storage: { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) }, userId: 'u1' });
    setSavedCopyStore(store);
    const v1Copy = { available: true, source: 'mirror', runtime_session_id: 'ses_a', captured_at: '2026-10-11T11:00:00Z', messages: [{ info: { id: 'msg_1', role: 'user' }, parts: [] }] };
    await store.write(PROJECT, SESSION, v1Copy as never);
    mount({ loader: async () => page() });
    await flush();
    expect(await savedSessionLogCopies(store)!.read(PROJECT, SESSION)).toBeNull();
    expect(store.read(PROJECT, SESSION)).not.toBeNull();
  });

  test('a 404 (a new session whose journal has not posted yet) is retried at the next turn end and on a stream reconnect', async () => {
    let calls = 0;
    let stored = false;
    const turn = (token: string) => ({ type: 'kortix.control.turn', cseq: 1, cepoch: 'c', at: 1, payload: { known: true, turns: [], last_ended: { turn_token: token } } });
    const state = mount({ loader: async () => { calls++; if (!stored) throw new Error('404'); return v1Page(); } });
    await flush();
    expect(state.dialect).toBe('v1');
    expect(calls).toBe(1);
    // It waits on the session stream without schema v2.
    expect(joined.map((j) => j.options.schema)).toEqual([undefined]);
    const watch = joined[0]!.options;
    act(() => watch.onControl(turn('t1')));
    act(() => watch.onControl(turn('t1')));
    await flush();
    expect(calls).toBe(1); // the first turn frame is the state at join, a repeat is not a turn end
    act(() => watch.onConnectionChange(true));
    act(() => watch.onConnectionChange(false));
    act(() => watch.onConnectionChange(true));
    await flush();
    expect(calls).toBe(2); // a reconnect retries
    stored = true;
    act(() => joined.at(-1)!.options.onControl(turn('t2')));
    await flush();
    expect(calls).toBe(3); // a turn end retries; this time the log is there
    expect(state.dialect).toBe('v2');
    expect(useSyncStore.getState().sessionLogs[SESSION]).toBeDefined();
    expect(joined.at(-1)!.options.schema).toBe('v2');
    expect(joined.filter((j) => j.options.schema !== 'v2').every((j) => j.closed)).toBe(true);
  });

  test('a 404 (no stored log) or an invalid page: v1, no session log, no schema v2', async () => {
    const bad = v1Page();
    (bad.messages[0] as Record<string, unknown>).seq = 'x';
    for (const loader of [async () => { throw new Error('404'); }, async () => bad]) {
      const state = mount({ loader });
      await flush();
      expect(state.dialect).toBe('v1');
      expect(useSyncStore.getState().sessionLogs).toEqual({});
      expect(joined.some((j) => j.options.schema === 'v2')).toBe(false);
      act(() => renderer?.unmount());
      renderer = null;
    }
  });

  test('the device copy paints first, the API page replaces it and is saved, and the v1 copy is dropped', async () => {
    const data = new Map<string, string>();
    const store = createSavedCopyStore({ storage: { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) }, userId: 'u1' });
    setSavedCopyStore(store);
    const saved = v1Page();
    saved.messages = saved.messages.slice(0, 3);
    await savedSessionLogCopies(store)!.write(PROJECT, SESSION, saved);
    let release: (value: unknown) => void = () => {};
    mount({ loader: () => new Promise((resolve) => { release = resolve; }) });
    await flush();
    expect(useSyncStore.getState().sessionLogs[SESSION]!.messages[log.threads[0]!.thread_id]).toHaveLength(3);
    await act(async () => release(v1Page()));
    await flush();
    expect(useSyncStore.getState().sessionLogs[SESSION]!.messages[log.threads[0]!.thread_id]).toHaveLength(log.threads[0]!.messages.length);
    expect((await savedSessionLogCopies(store)!.read(PROJECT, SESSION))!.messages).toHaveLength(log.threads[0]!.messages.length);
  });

  test('v2 stays latched while a reconnect clears the capability list: no drop, no refetch', async () => {
    let calls = 0;
    const loader = async () => {
      calls++;
      return v1Page();
    };
    const dialects: string[] = [];
    render(() => {
      dialects.push(useSessionLogSync(PROJECT, SESSION, { enabled: true, loader, joinStream: joinStream as never }));
      return null;
    });
    await flush();
    expect(useSyncStore.getState().sessionLogs[SESSION]).toBeDefined();
    act(() => setRuntimeCapabilities(null));
    await flush();
    act(() => setRuntimeCapabilities(['session.log.v2']));
    await flush();
    expect(dialects.at(-1)).toBe('v2');
    expect(dialects.slice(dialects.indexOf('v2'))).not.toContain('v1');
    expect(calls).toBe(1);
    expect(joined).toHaveLength(1);
  });

  for (const [name, setup] of [
    ['the flag is off', () => { flag = false; }],
    ['the API serves no flag', () => { flag = undefined; }],
    ['the runtime does not list session.log.v2', () => setRuntimeCapabilities(['session.rewind'])],
    ['no runtime health answered yet', () => setRuntimeCapabilities(null)],
  ] as const) {
    test(`v1 when ${name}: no page request, no session log`, async () => {
      setup();
      const calls: unknown[] = [];
      const state = mount({ loader: async (...a: unknown[]) => { calls.push(a); return v1Page(); } });
      await flush();
      expect(state.dialect).toBe('v1');
      expect(calls).toEqual([]);
      expect(useSyncStore.getState().sessionLogs).toEqual({});
      expect(joined).toEqual([]);
    });
  }

  test('v1 without a page loader, and the flag is not even read', async () => {
    const state = mount({ loader: null });
    await flush();
    expect(state.dialect).toBe('v1');
    expect(detailCalls).toEqual([]);
  });

  test('disabled: v1 and no request', async () => {
    const calls: unknown[] = [];
    const state = mount({ enabled: false, loader: async (...a: unknown[]) => { calls.push(a); return v1Page(); } });
    await flush();
    expect(state.dialect).toBe('v1');
    expect(calls).toEqual([]);
    expect(detailCalls).toEqual([]);
  });
});
