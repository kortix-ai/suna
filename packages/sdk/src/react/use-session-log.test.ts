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

const log: SessionLog = JSON.parse(readFileSync(join(import.meta.dir, '../../../api-contract/src/__tests__/fixtures/session-log/golden21.v2.json'), 'utf8'));
const PROJECT = 'proj_log';
const SESSION = 'kses_log';
const page = () => {
  const { threads, ...session } = structuredClone(log);
  return { session, generation: 1, threads: threads.map(({ messages: _m, ...head }) => head), messages: threads[0]!.messages, has_more: false };
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

describe('useSessionLogSync: negotiation and the first page', () => {
  test('v2: loads the root thread page into the store, and drops it when the session unmounts', async () => {
    const calls: unknown[][] = [];
    const loader = async (...args: unknown[]) => {
      calls.push(args.slice(0, 3));
      return page();
    };
    let dialect = '';
    render(() => {
      dialect = useSessionLogSync(PROJECT, SESSION, { enabled: true, loader });
      return null;
    });
    await flush();
    expect(dialect).toBe('v2');
    expect(calls).toEqual([[PROJECT, SESSION, { limit: 40 }]]);
    expect(useSyncStore.getState().sessionLogs[SESSION]!.session.session_id).toBe(log.session_id);
    act(() => renderer?.unmount());
    renderer = null;
    expect(useSyncStore.getState().sessionLogs[SESSION]).toBeUndefined();
  });

  test('v2 stays latched while a reconnect clears the capability list: no drop, no refetch', async () => {
    let calls = 0;
    const loader = async () => {
      calls++;
      return page();
    };
    const dialects: string[] = [];
    render(() => {
      dialects.push(useSessionLogSync(PROJECT, SESSION, { enabled: true, loader }));
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
    expect(useSyncStore.getState().sessionLogs[SESSION]).toBeDefined();
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
      let dialect = '';
      render(() => {
        dialect = useSessionLogSync(PROJECT, SESSION, { enabled: true, loader: async (...a: unknown[]) => { calls.push(a); return page(); } });
        return null;
      });
      await flush();
      expect(dialect).toBe('v1');
      expect(calls).toEqual([]);
      expect(useSyncStore.getState().sessionLogs).toEqual({});
    });
  }

  test('v1 without a page loader (the API route is not served yet), and the flag is not even read', async () => {
    let dialect = '';
    render(() => {
      dialect = useSessionLogSync(PROJECT, SESSION, { enabled: true });
      return null;
    });
    await flush();
    expect(dialect).toBe('v1');
    expect(detailCalls).toEqual([]);
  });

  test('disabled: v1 and no request', async () => {
    const calls: unknown[] = [];
    let dialect = '';
    render(() => {
      dialect = useSessionLogSync(PROJECT, SESSION, { enabled: false, loader: async (...a: unknown[]) => { calls.push(a); return page(); } });
      return null;
    });
    await flush();
    expect(dialect).toBe('v1');
    expect(calls).toEqual([]);
    expect(detailCalls).toEqual([]);
  });

  test('an invalid page leaves the session on the v1 rows', async () => {
    const bad = page();
    (bad.messages[0] as Record<string, unknown>).seq = 'x';
    render(() => {
      useSessionLogSync(PROJECT, SESSION, { enabled: true, loader: async () => bad });
      return null;
    });
    await flush();
    expect(useSyncStore.getState().sessionLogs).toEqual({});
  });
});
