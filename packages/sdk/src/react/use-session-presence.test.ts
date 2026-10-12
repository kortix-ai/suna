import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useSessionWorkingStore } from '../browser/stores/session-working-store';
import { configureKortix } from '../core/http/config';
import { PRESENCE_AWAKE_REFRESH_MS } from './human-presence';
import { useSession } from './opencode';
import { qk } from './query-keys';
import { sessionStartKey } from '../core/rest/projects-client/session-sandbox';

/**
 * KRTX-1742: the presence lease says whether this tab alerts on its own
 * (`presenceAlerts`). The server skips the phone and Web Push only for an
 * alerting tab, so a change to the flag must reach the lease at once — and
 * without an absent PUT, which deletes the lease and can race the present PUT
 * that follows it.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT_ID = '00000000-0000-4000-8000-0000000000b1';
const SESSION_ID = 'kses_presence';

type Listener = () => void;
function target() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    addEventListener: (type: string, fn: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: Listener) => listeners.get(type)?.delete(fn),
    fire: (type: string) => {
      for (const fn of listeners.get(type) ?? []) fn();
    },
  };
}

let puts: Array<{ body: { tab_id: string; active: boolean; alerts?: boolean }; keepalive: boolean }>;
let renderer: ReactTestRenderer | null = null;
let queryClient: QueryClient;
let win: ReturnType<typeof target>;
let doc: ReturnType<typeof target> & { hidden: boolean };
const globals = globalThis as { document?: unknown; window?: unknown };
const saved = { document: globals.document, window: globals.window };

beforeEach(() => {
  puts = [];
  doc = { hidden: false, ...target() };
  globals.document = doc;
  win = target();
  globals.window = { ...win, setInterval: () => 1, clearInterval: () => {} };
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  globalThis.fetch = mock(async (url: unknown, init: RequestInit = {}) => {
    if (String(url).endsWith('/presence')) {
      puts.push({ body: JSON.parse(String(init.body)), keepalive: init.keepalive === true });
    }
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  queryClient.clear();
  globals.document = saved.document;
  globals.window = saved.window;
});

function Host({ presenceAlerts, presencePageExit }: { presenceAlerts?: boolean; presencePageExit?: boolean }) {
  useSession(PROJECT_ID, SESSION_ID, {
    enabled: false,
    replayStartStash: false,
    chatEngine: false,
    browserPresence: true,
    presenceAlerts,
    presencePageExit,
  });
  return null;
}

function mount(props: { presenceAlerts?: boolean; presencePageExit?: boolean }) {
  return createElement(QueryClientProvider, { client: queryClient }, createElement(Host, props));
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

describe('useSession presence alerts', () => {
  test('the first present PUT carries alerts=false by default', async () => {
    act(() => {
      renderer = create(createElement(QueryClientProvider, { client: queryClient }, createElement(Host, {})));
    });
    await flush();
    expect(puts.map((p) => p.body.active)).toEqual([true]);
    expect(puts[0]!.body.alerts).toBe(false);
  });

  test('turning alerts on re-PUTs present with alerts=true, with no absent PUT in between', async () => {
    act(() => {
      renderer = create(
        createElement(QueryClientProvider, { client: queryClient }, createElement(Host, { presenceAlerts: false })),
      );
    });
    await flush();
    act(() => {
      renderer!.update(
        createElement(QueryClientProvider, { client: queryClient }, createElement(Host, { presenceAlerts: true })),
      );
    });
    await flush();
    expect(puts.map((p) => [p.body.active, p.body.alerts])).toEqual([
      [true, false],
      [true, true],
    ]);
    expect(new Set(puts.map((p) => p.body.tab_id)).size).toBe(1);
  });

  test('with presencePageExit, unmounting sends absent with keepalive, so a closing page still ends the lease', async () => {
    act(() => {
      renderer = create(mount({ presenceAlerts: true, presencePageExit: true }));
    });
    await flush();
    act(() => renderer!.unmount());
    renderer = null;
    await flush();
    expect(puts.map((p) => [p.body.active, p.keepalive])).toEqual([
      [true, false],
      [false, true],
    ]);
  });
});

/**
 * `presencePageExit` follows the project's `notification_center` flag. Off is
 * the presence before KRTX-1742: no `pagehide` report, and every absent PUT
 * (hidden, idle, unmount) goes without `keepalive`. A closing tab still turns
 * hidden and sends absent, but the browser may cancel that PUT as the page
 * unloads, and then the lease lives to its 90 s expiry. On, `pagehide` reports
 * absent too, and every absent PUT goes with `keepalive`, so it outlives the
 * page and ends the lease at once.
 */
describe('useSession presence page exit', () => {
  test('by default, pagehide sends no absent PUT', async () => {
    act(() => {
      renderer = create(mount({}));
    });
    await flush();
    act(() => win.fire('pagehide'));
    await flush();
    expect(puts.map((p) => p.body.active)).toEqual([true]);
  });

  test('by default, a closing page sends absent on visibilitychange without keepalive', async () => {
    act(() => {
      renderer = create(mount({}));
    });
    await flush();
    act(() => win.fire('pagehide'));
    act(() => {
      doc.hidden = true;
      doc.fire('visibilitychange');
    });
    await flush();
    expect(puts.map((p) => [p.body.active, p.keepalive])).toEqual([
      [true, false],
      [false, false],
    ]);
  });

  test('by default, unmounting sends absent without keepalive', async () => {
    act(() => {
      renderer = create(mount({ presenceAlerts: true }));
    });
    await flush();
    act(() => renderer!.unmount());
    renderer = null;
    await flush();
    expect(puts.map((p) => [p.body.active, p.keepalive])).toEqual([
      [true, false],
      [false, false],
    ]);
  });

  test('with presencePageExit, a page that turns hidden sends absent with keepalive', async () => {
    act(() => {
      renderer = create(mount({ presencePageExit: true }));
    });
    await flush();
    act(() => {
      doc.hidden = true;
      doc.fire('visibilitychange');
    });
    await flush();
    expect(puts.map((p) => [p.body.active, p.keepalive])).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  test('turning presencePageExit off after mount drops keepalive from the next absent PUT', async () => {
    act(() => {
      renderer = create(mount({ presencePageExit: true }));
    });
    await flush();
    act(() => renderer!.update(mount({ presencePageExit: false })));
    await flush();
    act(() => {
      doc.hidden = true;
      doc.fire('visibilitychange');
    });
    await flush();
    expect(puts.map((p) => [p.body.active, p.keepalive])).toEqual([
      [true, false],
      [false, false],
    ]);
  });

  test('with presencePageExit, pagehide sends absent with keepalive', async () => {
    act(() => {
      renderer = create(mount({ presencePageExit: true }));
    });
    await flush();
    act(() => win.fire('pagehide'));
    await flush();
    expect(puts.map((p) => [p.body.active, p.keepalive])).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  test('turning presencePageExit on after mount applies without an absent PUT', async () => {
    act(() => {
      renderer = create(mount({ presencePageExit: false }));
    });
    await flush();
    act(() => renderer!.update(mount({ presencePageExit: true })));
    await flush();
    expect(puts.map((p) => p.body.active)).toEqual([true]);
    act(() => win.fire('pagehide'));
    await flush();
    expect(puts.map((p) => [p.body.active, p.keepalive])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(new Set(puts.map((p) => p.body.tab_id)).size).toBe(1);
  });
});

/**
 * KRTX-1729: the composer says until when the computer stays on. The window
 * comes from each present PUT's response. The stream renews the lease without
 * one, so the view re-sends present on a timer and when a turn ends; an absent
 * report clears the window at once, and a late present response cannot bring
 * it back.
 */
describe('useSession presenceAwake', () => {
  const UNTIL = '2026-10-12T10:15:00.000Z';
  const CAP = '2026-10-12T11:40:00.000Z';
  type Body = { ok: boolean; awake_until: string | null; awake_cap_at: string | null };
  let reply: (active: boolean) => Body | Promise<Body>;
  let intervals: Array<{ fn: () => void; ms: number }>;
  let result: { presenceAwake: { until: Date; capAt: Date } | null } | null;

  beforeEach(() => {
    intervals = [];
    result = null;
    reply = (active) =>
      active ? { ok: true, awake_until: UNTIL, awake_cap_at: CAP } : { ok: true, awake_until: null, awake_cap_at: null };
    globals.window = {
      ...win,
      setInterval: (fn: () => void, ms: number) => intervals.push({ fn, ms }),
      clearInterval: () => {},
    };
    globalThis.fetch = mock(async (url: unknown, init: RequestInit = {}) => {
      if (!String(url).endsWith('/presence')) return Response.json({ ok: true });
      const body = JSON.parse(String(init.body));
      puts.push({ body, keepalive: init.keepalive === true });
      return Response.json(await reply(body.active));
    }) as unknown as typeof fetch;
  });

  function AwakeHost() {
    result = useSession(PROJECT_ID, SESSION_ID, {
      enabled: false,
      replayStartStash: false,
      chatEngine: false,
      browserPresence: true,
    });
    return null;
  }

  function mountAwake() {
    act(() => {
      renderer = create(createElement(QueryClientProvider, { client: queryClient }, createElement(AwakeHost)));
    });
  }

  test('a present PUT sets the window, and an absent report clears it', async () => {
    mountAwake();
    await flush();
    expect(result!.presenceAwake).toEqual({ until: new Date(UNTIL), capAt: new Date(CAP) });
    act(() => {
      doc.hidden = true;
      doc.fire('visibilitychange');
    });
    await flush();
    expect(result!.presenceAwake).toBeNull();
  });

  test('without browserPresence there is no window and no PUT', async () => {
    function Off() {
      result = useSession(PROJECT_ID, SESSION_ID, { enabled: false, replayStartStash: false, chatEngine: false });
      return null;
    }
    act(() => {
      renderer = create(createElement(QueryClientProvider, { client: queryClient }, createElement(Off)));
    });
    await flush();
    expect(result!.presenceAwake).toBeNull();
    expect(puts).toEqual([]);
  });

  test('a response with no window (a viewer, a stopped computer) clears it', async () => {
    mountAwake();
    await flush();
    reply = () => ({ ok: true, awake_until: null, awake_cap_at: null });
    const refresh = intervals.find((i) => i.ms === PRESENCE_AWAKE_REFRESH_MS);
    expect(refresh).toBeDefined();
    act(() => refresh!.fn());
    await flush();
    expect(puts.map((p) => p.body.active)).toEqual([true, true]);
    expect(result!.presenceAwake).toBeNull();
  });

  test('while present, the view re-reads the window on its refresh timer', async () => {
    mountAwake();
    await flush();
    const later = '2026-10-12T10:20:00.000Z';
    reply = () => ({ ok: true, awake_until: later, awake_cap_at: CAP });
    act(() => intervals.find((i) => i.ms === PRESENCE_AWAKE_REFRESH_MS)!.fn());
    await flush();
    expect(result!.presenceAwake).toEqual({ until: new Date(later), capAt: new Date(CAP) });
  });

  test('a turn that ends re-reads the window: the turn moved the cap', async () => {
    mountAwake();
    await flush();
    act(() => {
      useSessionWorkingStore.getState().noteSendReceipt(SESSION_ID, { messageId: 'msg_turn', atMs: Date.now() });
    });
    await flush();
    expect(puts).toHaveLength(1);
    const movedCap = '2026-10-12T13:00:00.000Z';
    reply = () => ({ ok: true, awake_until: UNTIL, awake_cap_at: movedCap });
    act(() => {
      useSessionWorkingStore.getState().clearSendReceipt(SESSION_ID, 'msg_turn');
    });
    await flush();
    expect(puts.map((p) => p.body.active)).toEqual([true, true]);
    expect(result!.presenceAwake).toEqual({ until: new Date(UNTIL), capAt: new Date(movedCap) });
  });

  test('a present response that lands after an absent report does not bring the window back', async () => {
    let release: (body: Body) => void = () => {};
    reply = (active) =>
      active
        ? new Promise<Body>((resolve) => {
            release = resolve;
          })
        : { ok: true, awake_until: null, awake_cap_at: null };
    mountAwake();
    await flush();
    act(() => {
      doc.hidden = true;
      doc.fire('visibilitychange');
    });
    await flush();
    release({ ok: true, awake_until: UNTIL, awake_cap_at: CAP });
    await flush();
    expect(puts.map((p) => p.body.active)).toEqual([true, false]);
    expect(result!.presenceAwake).toBeNull();
  });

  // The turn keeps the computer on and moves the cap, so the window from
  // before it is wrong after it. Without the clear, a "stops in 8 min" from
  // before a 2-min turn came back until the turn-end refresh answered.
  test('a turn that starts clears the window, and the window from before it does not come back', async () => {
    mountAwake();
    await flush();
    expect(result!.presenceAwake).not.toBeNull();
    act(() => {
      useSessionWorkingStore.getState().noteSendReceipt(SESSION_ID, { messageId: 'msg_clear', atMs: Date.now() });
    });
    await flush();
    expect(result!.presenceAwake).toBeNull();
    // The turn-end refresh has not answered yet.
    reply = () => new Promise<Body>(() => {});
    act(() => {
      useSessionWorkingStore.getState().clearSendReceipt(SESSION_ID, 'msg_clear');
    });
    await flush();
    expect(puts.map((p) => p.body.active)).toEqual([true, true]);
    expect(result!.presenceAwake).toBeNull();
  });

  // The runtime's idle frame lands before the control plane closes the turn
  // in its ledger (`endedByRuntime`: ~200 ms, 15 s in one measured case). A
  // refresh in that gap reads the open turn's deadline and cap. The ledger's
  // newest ended turn changing is the moment the server's window is right.
  test('the ledger closing a turn re-reads the window that the idle flip read too early', async () => {
    const turnKey = qk.project.sessionTurn(PROJECT_ID, SESSION_ID);
    const ledger = (token: string) => ({
      turns: [],
      last_ended: { turn_token: token, end_reason: 'completed', ended_at: '2026-10-12T09:58:00.000Z' },
      atMs: Date.now(),
    });
    mountAwake();
    await flush();
    // The first ledger read is no news, and a re-read of the same turn is none either.
    act(() => {
      queryClient.setQueryData(turnKey, ledger('turn_1'));
    });
    await flush();
    act(() => {
      queryClient.setQueryData(turnKey, ledger('turn_1'));
    });
    await flush();
    expect(puts).toHaveLength(1);

    const openTurn = { ok: true, awake_until: '2026-10-12T14:00:00.000Z', awake_cap_at: '2026-10-12T12:00:00.000Z' };
    reply = () => openTurn;
    act(() => {
      useSessionWorkingStore.getState().noteSendReceipt(SESSION_ID, { messageId: 'msg_ledger', atMs: Date.now() });
    });
    await flush();
    act(() => {
      useSessionWorkingStore.getState().clearSendReceipt(SESSION_ID, 'msg_ledger');
    });
    await flush();
    expect(result!.presenceAwake).toEqual({
      until: new Date(openTurn.awake_until),
      capAt: new Date(openTurn.awake_cap_at),
    });

    const closed = { ok: true, awake_until: '2026-10-12T10:15:00.000Z', awake_cap_at: '2026-10-12T12:00:00.000Z' };
    reply = () => closed;
    act(() => {
      queryClient.setQueryData(turnKey, ledger('turn_2'));
    });
    await flush();
    expect(puts.map((p) => p.body.active)).toEqual([true, true, true]);
    expect(result!.presenceAwake).toEqual({ until: new Date(closed.awake_until), capAt: new Date(closed.awake_cap_at) });
  });

  test('a sandbox that becomes ready reads the window at once, not at the next refresh', async () => {
    mountAwake();
    await flush();
    expect(puts).toHaveLength(1);
    act(() => {
      queryClient.setQueryData(sessionStartKey(PROJECT_ID, SESSION_ID), { stage: 'ready' });
    });
    await flush();
    expect(puts.map((p) => p.body.active)).toEqual([true, true]);
    expect(result!.presenceAwake).toEqual({ until: new Date(UNTIL), capAt: new Date(CAP) });
  });

  test('a sandbox that stops clears the window, and a late response does not bring it back', async () => {
    act(() => {
      queryClient.setQueryData(sessionStartKey(PROJECT_ID, SESSION_ID), { stage: 'ready' });
    });
    let release: (body: Body) => void = () => {};
    mountAwake();
    await flush();
    expect(result!.presenceAwake).toEqual({ until: new Date(UNTIL), capAt: new Date(CAP) });

    reply = () => new Promise<Body>((resolve) => { release = resolve; });
    act(() => {
      intervals.find((i) => i.ms === PRESENCE_AWAKE_REFRESH_MS)!.fn();
    });
    act(() => {
      queryClient.setQueryData(sessionStartKey(PROJECT_ID, SESSION_ID), { stage: 'stopped' });
    });
    await flush();
    expect(result!.presenceAwake).toBeNull();
    release({ ok: true, awake_until: UNTIL, awake_cap_at: CAP });
    await flush();
    expect(result!.presenceAwake).toBeNull();
  });
});
