import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { configureKortix } from '../core/http/config';
import { useSession } from './opencode';

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
const globals = globalThis as { document?: unknown; window?: unknown };
const saved = { document: globals.document, window: globals.window };

beforeEach(() => {
  puts = [];
  globals.document = { hidden: false, ...target() };
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

  test('unmounting sends absent with keepalive, so a closing page still ends the lease', async () => {
    act(() => {
      renderer = create(
        createElement(QueryClientProvider, { client: queryClient }, createElement(Host, { presenceAlerts: true })),
      );
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
 * the presence before KRTX-1742: a closing page sends no absent PUT, and the
 * lease lives to its 90 s expiry. On, `pagehide` ends the lease at once.
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
    expect(puts.map((p) => p.body.active)).toEqual([true, false]);
    expect(new Set(puts.map((p) => p.body.tab_id)).size).toBe(1);
  });
});
