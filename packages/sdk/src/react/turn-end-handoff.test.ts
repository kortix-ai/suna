import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { configureKortix } from '../core/http/config';
import type { ProjectSession, SessionTurnStatus } from '../core/rest/projects-client/sessions';
import { TURN_END_WATCH_FIRST_READ_MS, TURN_END_WATCH_POLL_MS } from '../core/session/turn-end-watch';
import { qk } from './query-keys';
import { resetIdentityState } from './reset-identity-state';
import {
  type TurnEndHandoffInput,
  resetTurnEndHandoffForTests,
  turnEndHandoffWatching,
  useTurnEndHandoff,
} from './turn-end-handoff';

/**
 * The session page's half of the turn-end hand-off (KRTX-2520 follow-up).
 *
 * Repro on 2026-10-16: start a turn in session X, open the project home in the
 * same window, let X finish. Nothing announced it: the only announcer is the
 * session page's live stream, and it unmounted with the page. These tests mount
 * the hook the session page mounts, unmount it mid-turn, and let a scripted
 * `/turn` read report the end. The host's `onNotify` sink is the assertion: it
 * is what turns into the toast, `markTurnComplete`, the favicon dot and the
 * Dock badge in `apps/web`.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT_ID = 'P1';

const RUNNING: SessionTurnStatus = {
  turns: [
    {
      turn_token: 'T1',
      state: 'active',
      message_id: 'm1',
      opencode_session_id: 'oc1',
      started_at: null,
      accepted_at: null,
    },
  ],
};
const COMPLETED: SessionTurnStatus = {
  turns: [],
  last_ended: { turn_token: 'T1', message_id: 'm1', end_reason: 'completed', ended_at: null },
};
const FAILED: SessionTurnStatus = {
  turns: [],
  last_ended: {
    turn_token: 'T1',
    message_id: 'm1',
    end_reason: 'failed',
    ended_at: null,
    error: { name: 'APIError', message: 'The model provider rejected the request.' },
  },
};

type Notified = { kind: string; sessionId: string; [key: string]: unknown };

let notified: Notified[];
let reads: Map<string, SessionTurnStatus[]>;
let readCount: number;
let clockMs: number;
let timers: Map<number, { at: number; fn: () => void }>;
let queryClient: QueryClient;

function installWatch() {
  let nextId = 1;
  resetTurnEndHandoffForTests({
    readTurn: async (projectId, sessionId) => {
      readCount++;
      const list = reads.get(`${projectId}/${sessionId}`) ?? [COMPLETED];
      return list.length > 1 ? list.shift()! : list[0];
    },
    now: () => clockMs,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: clockMs + ms, fn });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id as number);
    },
  });
}

async function advance(ms: number) {
  const until = clockMs + ms;
  for (;;) {
    const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    timers.delete(due[0]);
    clockMs = due[1].at;
    due[1].fn();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
  clockMs = until;
}

function Page(props: TurnEndHandoffInput) {
  useTurnEndHandoff(props);
  return null;
}

function page(props: Partial<TurnEndHandoffInput> = {}): TurnEndHandoffInput {
  return {
    enabled: true,
    projectId: PROJECT_ID,
    sessionId: 'S1',
    runtimeSessionId: 'oc1',
    working: true,
    openTurnToken: 'T1',
    lastEndedToken: 'T0',
    ...props,
  };
}

function mount(props: TurnEndHandoffInput): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      createElement(QueryClientProvider, { client: queryClient }, createElement(Page, props)),
    );
  });
  return renderer;
}

function rerender(renderer: ReactTestRenderer, props: TurnEndHandoffInput) {
  act(() => {
    renderer.update(createElement(QueryClientProvider, { client: queryClient }, createElement(Page, props)));
  });
}

function unmount(renderer: ReactTestRenderer) {
  act(() => renderer.unmount());
}

function seedSessionRow(sessionId: string, name: string) {
  queryClient.setQueryData(qk.project.sessions(PROJECT_ID), [
    { session_id: sessionId, name, custom_name: null } as unknown as ProjectSession,
  ]);
}

beforeEach(() => {
  notified = [];
  reads = new Map();
  readCount = 0;
  clockMs = 5_000_000;
  timers = new Map();
  queryClient = new QueryClient();
  configureKortix({
    backendUrl: 'http://kortix.invalid/v1',
    getToken: async () => null,
    onNotify: (event) => notified.push(event),
  });
  installWatch();
});

afterEach(() => {
  resetTurnEndHandoffForTests();
});

describe('useTurnEndHandoff', () => {
  test('a turn left running by an unmounted page is announced when it ends', async () => {
    reads.set('P1/S1', [RUNNING, COMPLETED]);
    seedSessionRow('S1', 'Fix the login bug');
    const renderer = mount(page());
    unmount(renderer);
    expect(turnEndHandoffWatching()).toEqual(['P1/S1']);

    await advance(TURN_END_WATCH_FIRST_READ_MS + TURN_END_WATCH_POLL_MS);

    expect(notified).toEqual([
      {
        kind: 'task-complete',
        sessionId: 'S1',
        sessionTitle: 'Fix the login bug',
        watchedSinceMs: 5_000_000,
        projectId: 'P1',
      },
    ]);
    expect(turnEndHandoffWatching()).toEqual([]);
  });

  test('a failure while the page is away is announced as an error, with its cause', async () => {
    reads.set('P1/S1', [FAILED]);
    unmount(mount(page()));
    await advance(TURN_END_WATCH_FIRST_READ_MS);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({
      kind: 'session-error',
      sessionId: 'S1',
      errorTitle: 'The model provider rejected the request.',
      projectId: 'P1',
    });
  });

  test('a page that leaves an idle session hands nothing over', async () => {
    unmount(mount(page({ working: false, openTurnToken: null })));
    expect(turnEndHandoffWatching()).toEqual([]);
    await advance(TURN_END_WATCH_POLL_MS * 4);
    expect(readCount).toBe(0);
    expect(notified).toEqual([]);
  });

  test('the page mounting again takes the turn back: its stream announces, not the watch', async () => {
    reads.set('P1/S1', [COMPLETED]);
    unmount(mount(page()));
    const back = mount(page());
    expect(turnEndHandoffWatching()).toEqual([]);
    await advance(TURN_END_WATCH_POLL_MS * 4);
    expect(readCount).toBe(0);
    expect(notified).toEqual([]);
    unmount(back);
  });

  test('switching sessions in one mounted page hands over the session it left, not the new one', async () => {
    reads.set('P1/S1', [COMPLETED]);
    const renderer = mount(page({ sessionId: 'S1' }));
    // The new session's first render reads idle: the hand-off must still use
    // what the page knew about S1 when it left it.
    rerender(renderer, page({ sessionId: 'S2', working: false, openTurnToken: null }));
    expect(turnEndHandoffWatching()).toEqual(['P1/S1']);
    await advance(TURN_END_WATCH_FIRST_READ_MS);
    expect(notified.map((event) => event.sessionId)).toEqual(['S1']);
    unmount(renderer);
    expect(turnEndHandoffWatching()).toEqual([]);
  });

  test('a disabled page hands nothing over', () => {
    unmount(mount(page({ enabled: false })));
    expect(turnEndHandoffWatching()).toEqual([]);
  });

  test('signing out (resetIdentityState) ends every watch: nobody is left to tell', async () => {
    reads.set('P1/S1', [RUNNING]);
    unmount(mount(page()));
    unmount(mount(page({ sessionId: 'S2' })));
    expect(turnEndHandoffWatching()).toEqual(['P1/S1', 'P1/S2']);
    resetIdentityState();
    expect(turnEndHandoffWatching()).toEqual([]);
    await advance(TURN_END_WATCH_POLL_MS * 4);
    expect(readCount).toBe(0);
  });

  test('the default /turn read is silent: a failed background read never raises the host error toast', async () => {
    // The watch runs on pages that have nothing to do with the session; a
    // 503 there must not pop the global "request failed" toast.
    const errors: unknown[] = [];
    let turnReads = 0;
    configureKortix({
      backendUrl: 'http://kortix.invalid/v1',
      getToken: async () => 'token',
      onNotify: (event) => notified.push(event),
      onError: (error) => errors.push(error),
      fetch: async (input) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.endsWith('/projects/P1/sessions/S1/turn')) return new Response('{}', { status: 404 });
        turnReads++;
        return turnReads === 1
          ? new Response(JSON.stringify({ error: 'boom' }), { status: 500 })
          : Response.json(COMPLETED);
      },
    });
    resetTurnEndHandoffForTests({
      now: () => clockMs,
      setTimer: (fn, ms) => {
        const id = timers.size + 1000 + turnReads * 10;
        timers.set(id, { at: clockMs + ms, fn });
        return id;
      },
      clearTimer: (id) => {
        timers.delete(id as number);
      },
    });
    unmount(mount(page()));
    for (let i = 0; i < 4 && notified.length === 0; i++) {
      await advance(TURN_END_WATCH_POLL_MS);
      // The real transport resolves on real timers: let it.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(turnReads).toBe(2);
    expect(errors).toEqual([]);
    expect(notified).toMatchObject([{ kind: 'task-complete', sessionId: 'S1' }]);
  });

  test('a host with no notification sink watches nothing (no /turn reads for no one)', async () => {
    configureKortix({ backendUrl: 'http://kortix.invalid/v1', getToken: async () => null });
    unmount(mount(page()));
    expect(turnEndHandoffWatching()).toEqual([]);
    await advance(TURN_END_WATCH_POLL_MS * 4);
    expect(readCount).toBe(0);
  });
});
