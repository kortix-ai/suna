import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, useState, type ReactNode } from 'react';
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
const { useSessionLog, useSessionLogRecord, useSessionLogSync, useSessionLogThread } = await import('./use-session-log');
const { createSavedCopyStore, setSavedCopyStore } = await import('../core/session-sync/saved-copy-store');
const { savedSessionLogCopies } = await import('../core/session-log/saved-log');
const v1Convert = await import('../core/session-log/v1');

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

describe('useSessionLogThread on v2: throttleMs paces the thread', () => {
  const put = (i: number) => ({ ...log.threads[0]!.messages.at(-1)!, message_id: `msg_zzzpaced${String(i).padStart(2, '0')}`, seq: 1000 + i });
  const apply = (i: number) => useSyncStore.getState().applySessionLogEvent(SESSION, { type: 'log.message', properties: { rev: i, message: put(i) } });

  test('N log events inside one window render at most twice (leading and trailing edge), and the last one lands', async () => {
    act(() => useSyncStore.getState().applySessionLogPage(SESSION, page()));
    let renders = 0;
    const seen: Array<ReturnType<typeof useSessionLogThread>> = [];
    render(() => {
      renders++;
      seen.push(useSessionLogThread({ projectId: PROJECT, sessionId: SESSION }, undefined, { throttleMs: 200 }));
      return null;
    });
    expect(seen.at(-1)!.messages).toEqual(log.threads[0]!.messages);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    const before = renders;
    for (let i = 1; i <= 20; i++) act(() => apply(i));
    // The leading edge shows the first event at once; the other 19 wait for the window.
    expect(renders - before).toBe(1);
    expect(seen.at(-1)!.messages.at(-1)!.message_id).toBe(put(1).message_id);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(renders - before).toBe(2);
    expect(seen.at(-1)!.messages.at(-1)).toEqual(put(20));
  });

  test('identity: a re-render between ticks, with no store change, returns the same thread', () => {
    act(() => useSyncStore.getState().applySessionLogPage(SESSION, page()));
    const seen: Array<ReturnType<typeof useSessionLogThread>> = [];
    let bump: () => void = () => {};
    render(() => {
      const [, set] = useState(0);
      bump = () => set((n) => n + 1);
      seen.push(useSessionLogThread({ projectId: PROJECT, sessionId: SESSION }, undefined, { throttleMs: 200 }));
      return null;
    });
    act(() => bump());
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[0]).not.toBeNull();
    expect(seen.at(-1)).toBe(seen[0]);
  });

  test('the v2 log arriving after mount shows at once, and dropping it returns to the v1 thread', async () => {
    let shown: ReturnType<typeof useSessionLogThread> | undefined;
    render(() => {
      shown = useSessionLogThread({ projectId: PROJECT, sessionId: SESSION }, undefined, { throttleMs: 200 });
      return null;
    });
    expect(shown).toBeNull();
    act(() => useSyncStore.getState().applySessionLogPage(SESSION, page()));
    expect(shown!.messages).toEqual(log.threads[0]!.messages);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    act(() => useSyncStore.getState().dropSessionLog(SESSION));
    expect(shown).toBeNull();
  });
});

describe('useSessionLog / useSessionLogThread without v2: the fromV1 view of the v1 rows', () => {
  const { fromV1, toV1 } = v1Convert;
  const v1Log = structuredClone(log);
  for (const t of v1Log.threads) t.ext = { ...t.ext, opencode: { version: 'kortix.transcript.v1', native_id: t.thread_id } };
  const v1 = toV1(v1Log);
  const RS = v1.root_id!;
  const rows = v1.rows.filter((r) => r.runtime_session_id === RS).map((r) => ({ info: r.info, parts: r.parts }));
  const session = { projectId: PROJECT, sessionId: SESSION, runtimeSessionId: RS };

  test('source v1: the log equals fromV1 (live) of the rows the v1 hooks render; the root thread is its thread', () => {
    act(() => useSyncStore.getState().hydrate(RS, rows as never));
    const seen: Array<{ log: ReturnType<typeof useSessionLog>; root: unknown; byId: unknown }> = [];
    render(() => {
      seen.push({ log: useSessionLog(session), root: useSessionLogThread(session), byId: useSessionLogThread(session, RS) });
      return null;
    });
    const last = seen.at(-1)!;
    const expected = fromV1({ session_id: SESSION, root_id: RS, rows: rows.map((r) => ({ runtime_session_id: RS, ...r })) as never }, { live: true });
    expect(last.log!.source).toBe('v1');
    const { source: _source, ...plain } = last.log!;
    expect(plain).toEqual(expected);
    expect(last.root).toBe(last.log!.threads[0]!);
    expect(last.byId).toBe(last.log!.threads[0]!);
  });

  test('throttleMs paces the v1 rows the thread reads, as useSessionMessages paces them', async () => {
    act(() => useSyncStore.getState().hydrate(RS, rows as never));
    const seen: Array<string | undefined> = [];
    render(() => {
      seen.push(useSessionLogThread(session, undefined, { throttleMs: 200 })?.messages.at(-1)?.message_id);
      return null;
    });
    expect(seen.at(-1)).toBe(rows.at(-1)!.info.id);
    const send = (id: string) => {
      const info = { id, sessionID: RS, role: 'user', time: { created: Date.now() }, agent: 'build', model: { providerID: 'p', modelID: 'm' } };
      useSyncStore.getState().optimisticAdd(RS, info as never, [{ id: `prt_${id}`, sessionID: RS, messageID: id, type: 'text', text: id } as never]);
    };
    // The first change after a quiet interval shows at once; the next one waits for the window.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
      send('msg_zzzpaced1');
    });
    expect(seen.at(-1)).toBe('msg_zzzpaced1');
    act(() => send('msg_zzzpaced2'));
    expect(seen.at(-1)).toBe('msg_zzzpaced1');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(seen.at(-1)).toBe('msg_zzzpaced2');
  });

  test('identity: a re-render with no store change returns the same log, thread and messages', () => {
    act(() => useSyncStore.getState().hydrate(RS, rows as never));
    const seen: Array<ReturnType<typeof useSessionLog>> = [];
    let bump: () => void = () => {};
    render(() => {
      const [, set] = useState(0);
      bump = () => set((n) => n + 1);
      seen.push(useSessionLog(session));
      return null;
    });
    act(() => bump());
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[0]).not.toBeNull();
    expect(seen.at(-1)).toBe(seen[0]);
  });

  test('with a v2 log a v1 row change re-renders no consumer (the v1 fallback is not computed)', () => {
    act(() => useSyncStore.getState().hydrate(RS, rows as never));
    act(() => useSyncStore.getState().applySessionLogPage(SESSION, page()));
    let renders = 0;
    const seen: Array<{ log: ReturnType<typeof useSessionLog>; root: unknown }> = [];
    render(() => {
      renders++;
      seen.push({ log: useSessionLog(session), root: useSessionLogThread(session) });
      return null;
    });
    expect(seen.at(-1)!.log!.source).toBe('v2');
    const before = renders;
    // The v1 store gets a new row set for the same runtime session (a v1 frame while v2 is read).
    act(() => useSyncStore.getState().hydrate(RS, rows.slice(0, -1) as never));
    expect(renders).toBe(before);
    expect(seen.at(-1)!.log!.source).toBe('v2');
  });

  test('an optimistic send shows as the thread\'s last message on v1 and on v2, until the log holds it', () => {
    act(() => useSyncStore.getState().hydrate(RS, rows as never));
    const seen: Array<ReturnType<typeof useSessionLogThread>> = [];
    render(() => {
      seen.push(useSessionLogThread(session));
      return null;
    });
    const sent = { id: 'msg_zzzoptimistic', sessionID: RS, role: 'user', time: { created: Date.now() }, agent: 'build', model: { providerID: 'p', modelID: 'm' } };
    const part = { id: 'prt_zzzoptimistic', sessionID: RS, messageID: sent.id, type: 'text', text: 'just sent' };
    act(() => useSyncStore.getState().optimisticAdd(RS, sent as never, [part as never]));
    expect(seen.at(-1)!.messages.at(-1)).toMatchObject({ message_id: sent.id, role: 'user', status: 'complete', blocks: [{ type: 'text', text: 'just sent' }] });
    act(() => useSyncStore.getState().applySessionLogPage(SESSION, page()));
    const v2 = seen.at(-1)!;
    expect(v2.messages.at(-1)).toMatchObject({ message_id: sent.id, role: 'user', status: 'complete', blocks: [{ type: 'text', text: 'just sent' }] });
    expect(v2.messages.slice(0, -1)).toEqual(log.threads[0]!.messages);
    // The log's put of the same id replaces it: the v1 row stays out.
    const put = { ...log.threads[0]!.messages.at(-1)!, message_id: sent.id, seq: 999 };
    act(() => useSyncStore.getState().applySessionLogEvent(SESSION, { type: 'log.message', properties: { rev: 1, message: put } }));
    expect(seen.at(-1)!.messages.at(-1)).toEqual(put);
  });

  test('a re-minted optimistic send (a different echo id) leaves once the log holds the echo id', () => {
    act(() => useSyncStore.getState().hydrate(RS, rows as never));
    const seen: Array<ReturnType<typeof useSessionLogThread>> = [];
    render(() => {
      seen.push(useSessionLogThread(session));
      return null;
    });
    act(() => useSyncStore.getState().applySessionLogPage(SESSION, page()));
    const stub = { id: 'msg_zzzstub', sessionID: RS, role: 'user', time: { created: Date.now() }, agent: 'build', model: { providerID: 'p', modelID: 'm' } };
    act(() => useSyncStore.getState().optimisticAdd(RS, stub as never, [{ id: 'prt_zzzstub', sessionID: RS, messageID: stub.id, type: 'text', text: 'sent' } as never]));
    expect(seen.at(-1)!.messages.at(-1)!.message_id).toBe(stub.id);
    // The control plane re-mints the prompt: the inbox announces the echo id, then the log's put arrives under it.
    act(() => useSyncStore.getState().registerOptimisticEcho(RS, stub.id, 'msg_zzzecho'));
    const put = { ...log.threads[0]!.messages.at(-1)!, message_id: 'msg_zzzecho', seq: 999 };
    act(() => useSyncStore.getState().applySessionLogEvent(SESSION, { type: 'log.message', properties: { rev: 1, message: put } }));
    const ids = seen.at(-1)!.messages.map((m) => m.message_id);
    expect(ids.at(-1)).toBe('msg_zzzecho');
    expect(ids).not.toContain(stub.id);
  });

  test('null without a runtime session id; source v2 once a page is in the store', () => {
    act(() => useSyncStore.getState().hydrate(RS, rows as never));
    const seen: Array<{ none: unknown; log: ReturnType<typeof useSessionLog> }> = [];
    render(() => {
      seen.push({ none: useSessionLog({ projectId: PROJECT, sessionId: SESSION }), log: useSessionLog(session) });
      return null;
    });
    expect(seen.at(-1)!.none).toBeNull();
    act(() => useSyncStore.getState().applySessionLogPage(SESSION, page()));
    expect(seen.at(-1)!.log!.source).toBe('v2');
    expect(seen.at(-1)!.log!.session_id).toBe(log.session_id);
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

  test('a native thread (pi: no kortix.transcript.v1 ext): v2, the page goes in the store, the stream switches to schema v2', async () => {
    const state = mount({ loader: async () => page() });
    await flush();
    expect(state.dialect).toBe('v2');
    expect(useSyncStore.getState().sessionLogs[SESSION]!.messages[log.threads[0]!.thread_id]).toHaveLength(log.threads[0]!.messages.length);
    expect(joined.map((j) => j.options.schema)).toEqual(['v2']);
  });

  test('a native page replaces the v1 device copy with the v2 copy, and the saved native copy paints first', async () => {
    const data = new Map<string, string>();
    const store = createSavedCopyStore({ storage: { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) }, userId: 'u1' });
    setSavedCopyStore(store);
    const v1Copy = { available: true, source: 'mirror', runtime_session_id: 'ses_a', captured_at: '2026-10-11T11:00:00Z', messages: [{ info: { id: 'msg_1', role: 'user' }, parts: [] }] };
    await store.write(PROJECT, SESSION, v1Copy as never);
    mount({ loader: async () => page() });
    await flush();
    expect((await savedSessionLogCopies(store)!.read(PROJECT, SESSION))!.messages).toHaveLength(log.threads[0]!.messages.length);
    expect(store.read(PROJECT, SESSION)).toBeNull();
    act(() => renderer?.unmount());
    renderer = null;
    mount({ loader: () => new Promise(() => {}) });
    await flush();
    expect(useSyncStore.getState().sessionLogs[SESSION]!.messages[log.threads[0]!.thread_id]).toHaveLength(log.threads[0]!.messages.length);
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

  test('a kortix.resync on the v2 connection re-reads the page once, with no duplicate messages', async () => {
    let calls = 0;
    mount({ loader: async () => { calls++; return v1Page(); } });
    await flush();
    expect(calls).toBe(1);
    const v2 = joined.at(-1)!.options;
    expect(v2.schema).toBe('v2');
    act(() => v2.onRuntimeResync());
    await flush();
    expect(calls).toBe(2);
    await flush();
    expect(calls).toBe(2);
    const ids = useSyncStore.getState().sessionLogs[SESSION]!.messages[log.threads[0]!.thread_id]!.map((m) => m.message_id);
    expect(ids).toEqual(log.threads[0]!.messages.map((m) => m.message_id));
  });

  test('a reconnect and a turn end together while a retry is in flight start one request', async () => {
    let calls = 0;
    let release: (value: unknown) => void = () => {};
    const turn = (token: string) => ({ type: 'kortix.control.turn', cseq: 1, cepoch: 'c', at: 1, payload: { known: true, turns: [], last_ended: { turn_token: token } } });
    mount({
      loader: () => {
        calls++;
        if (calls === 1) return Promise.reject(new Error('404'));
        return new Promise((_, reject) => { release = () => reject(new Error('404')); });
      },
    });
    await flush();
    const watch = joined[0]!.options;
    act(() => watch.onControl(turn('t1')));
    act(() => watch.onConnectionChange(false));
    act(() => watch.onConnectionChange(true));
    act(() => watch.onControl(turn('t2')));
    await flush();
    expect(calls).toBe(2);
    await act(async () => release(undefined));
    await flush();
    expect(calls).toBe(2);
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

describe('useSessionLogRecord', () => {
  const source = { projectId: PROJECT, sessionId: SESSION, runtimeSessionId: null };
  const put = (n: number) => {
    const m = structuredClone(log.threads[0]!.messages.at(-1)!);
    return { type: 'log.message', properties: { rev: 1_000 + n, message: { ...m, message_id: `msg_put_${n}`, seq: 900 + n } } };
  };

  test('null without a v2 log; the session record (grade, harness, ext) with one', () => {
    const seen: Array<ReturnType<typeof useSessionLogRecord>> = [];
    render(() => {
      seen.push(useSessionLogRecord(source));
      return null;
    });
    expect(seen.at(-1)).toBeNull();
    act(() => useSyncStore.getState().applySessionLogPage(SESSION, page()));
    expect(seen.at(-1)).toMatchObject({ restore_grade: log.restore_grade, harness: log.harness });
  });

  test('message puts and deltas re-render no consumer; a session patch does', () => {
    act(() => useSyncStore.getState().applySessionLogPage(SESSION, page()));
    let renders = 0;
    render(() => {
      renders++;
      useSessionLogRecord(source);
      return null;
    });
    const before = renders;
    act(() => {
      for (let n = 0; n < 20; n++) useSyncStore.getState().applySessionLogEvent(SESSION, put(n));
    });
    expect(renders).toBe(before);
    act(() => useSyncStore.getState().applySessionLogEvent(SESSION, { type: 'log.state', properties: { generation: 2, session: { restore_grade: 'partial' } } }));
    expect(renders).toBe(before + 1);
  });
});
