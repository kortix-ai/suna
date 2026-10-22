import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureKortix } from '../core/http/config';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type InboxNotification,
  type InboxNotificationPage,
  type NotificationPreferences,
} from '../core/rest/projects-client/notifications';
import { qk } from './query-keys';
import {
  notificationInboxQueryOptions,
  useNotificationInbox,
  useNotificationPreferences,
  useSessionWatch,
} from './use-notifications';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const USER = '00000000-0000-4000-8000-0000000000a1';

function row(id: string, sessionId: string | null, read = false): InboxNotification {
  return {
    id,
    kind: 'turn_done',
    title: `Session ${id}`,
    body: '',
    project_id: 'P1',
    project_name: 'Synthetic project',
    session_id: sessionId,
    trigger_slug: null,
    actor_user_id: null,
    url: `/projects/P1/sessions/${sessionId}?notification=${id}`,
    read,
    created_at: '2026-10-09T10:00:00.000Z',
  };
}

const PAGE: InboxNotificationPage = {
  notifications: [row('n1', 'S1'), row('n2', 'S1'), row('n3', 'S2'), row('n4', 'S2', true)],
  unread_count: 3,
  next_before: null,
};

/** A request the test answers by hand, to observe the optimistic state in between. */
interface Pending {
  method: string;
  path: string;
  body: unknown;
  respond: (status: number, body: unknown) => void;
}

let requests: Array<{ method: string; path: string; body: unknown }>;
let held: Pending[];
let hold: (method: string) => boolean;
let answer: (method: string, path: string, body: unknown) => { status: number; body: unknown };

beforeEach(() => {
  requests = [];
  held = [];
  hold = () => false;
  answer = () => ({ status: 200, body: {} });
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  globalThis.fetch = mock((url: unknown, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const u = new URL(String(url));
    const path = `${u.pathname}${u.search}`;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ method, path, body });
    const toResponse = (status: number, payload: unknown) => Response.json(payload, { status });
    if (hold(method)) {
      return new Promise<Response>((resolve) => {
        held.push({ method, path, body, respond: (status, payload) => resolve(toResponse(status, payload)) });
      });
    }
    const out = answer(method, path, body);
    return Promise.resolve(toResponse(out.status, out.body));
  }) as unknown as typeof fetch;
});

let renderer: ReactTestRenderer | null = null;
let client: QueryClient;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  client?.clear();
});

async function mount(node: React.ReactNode) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = create(React.createElement(QueryClientProvider, { client }, node));
  });
  await settle();
}

async function settle(ms = 20) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe('notificationInboxQueryOptions', () => {
  test('polls every 60 s only while the page is visible, refetches on focus, keyed by user and page size', () => {
    const options = notificationInboxQueryOptions(USER, 20);
    expect(options.queryKey).toEqual(qk.notifications.inbox(USER, 20));
    expect(options.refetchInterval).toBe(60_000);
    expect(options.refetchIntervalInBackground).toBe(false);
    expect(options.refetchOnWindowFocus).toBe(true);
    expect(options.enabled).toBe(true);
  });

  test('fails closed without a user id', () => {
    expect(notificationInboxQueryOptions(null, 20).enabled).toBe(false);
    expect(notificationInboxQueryOptions(undefined, 20).enabled).toBe(false);
    expect(notificationInboxQueryOptions(USER, 20, false).enabled).toBe(false);
  });
});

describe('useNotificationInbox', () => {
  let inbox: ReturnType<typeof useNotificationInbox>;
  function Inbox(props: { userId: string | null; limit?: number }) {
    inbox = useNotificationInbox(props);
    return null;
  }

  test('no user: no request, and not an endless load', async () => {
    await mount(React.createElement(Inbox, { userId: null }));
    expect(requests).toEqual([]);
    expect(inbox!.isLoading).toBe(false);
    expect(inbox!.unreadCount).toBe(0);
  });

  test('reads the page under the user key and exposes the unread count', async () => {
    answer = () => ({ status: 200, body: PAGE });
    await mount(React.createElement(Inbox, { userId: USER, limit: 10 }));
    expect(requests).toEqual([{ method: 'GET', path: '/notifications?limit=10', body: undefined }]);
    expect(inbox!.data).toEqual(PAGE);
    expect(inbox!.unreadCount).toBe(3);
    expect(client.getQueryData<InboxNotificationPage>(qk.notifications.inbox(USER, 10))).toEqual(PAGE);
  });

  test('markRead marks the rows at once, posts the ids, then refetches the inbox', async () => {
    answer = (method) => (method === 'GET' ? { status: 200, body: PAGE } : { status: 200, body: { updated: 1, unread_count: 2 } });
    await mount(React.createElement(Inbox, { userId: USER }));
    hold = (method) => method === 'POST';
    let done!: Promise<unknown>;
    await act(async () => {
      done = inbox!.markRead(['n1']);
    });
    await settle();
    expect(inbox!.data?.notifications.map((n) => n.read)).toEqual([true, false, false, true]);
    expect(inbox!.unreadCount).toBe(2);
    expect(held[0]).toMatchObject({ method: 'POST', path: '/notifications/read', body: { ids: ['n1'] } });
    const before = requests.filter((r) => r.method === 'GET').length;
    await act(async () => {
      held[0]!.respond(200, { updated: 1, unread_count: 2 });
      await done;
    });
    await settle();
    expect(requests.filter((r) => r.method === 'GET').length).toBe(before + 1);
  });

  test('markAllRead marks every row read and zeroes the count at once', async () => {
    answer = () => ({ status: 200, body: PAGE });
    await mount(React.createElement(Inbox, { userId: USER }));
    hold = (method) => method === 'POST';
    await act(async () => {
      void inbox!.markAllRead();
    });
    await settle();
    expect(inbox!.data?.notifications.every((n) => n.read)).toBe(true);
    expect(inbox!.unreadCount).toBe(0);
    expect(held[0]?.body).toEqual({ all: true });
    await act(async () => held[0]!.respond(200, { updated: 3, unread_count: 0 }));
  });

  test('markSessionRead marks only that session\'s rows and sends session_id', async () => {
    answer = () => ({ status: 200, body: PAGE });
    await mount(React.createElement(Inbox, { userId: USER }));
    hold = (method) => method === 'POST';
    await act(async () => {
      void inbox!.markSessionRead('S2');
    });
    await settle();
    expect(inbox!.data?.notifications.map((n) => n.read)).toEqual([false, false, true, true]);
    expect(inbox!.unreadCount).toBe(2);
    expect(held[0]?.body).toEqual({ session_id: 'S2' });
    await act(async () => held[0]!.respond(200, { updated: 1, unread_count: 2 }));
  });

  test('a rejected write restores the rows and the count, and rejects to the caller', async () => {
    answer = (method) =>
      method === 'GET' ? { status: 200, body: PAGE } : { status: 500, body: { error: 'boom' } };
    await mount(React.createElement(Inbox, { userId: USER }));
    // Hold the refetch that follows the write: only the rollback may restore the rows.
    hold = (method) => method === 'GET';
    let failure: unknown = null;
    await act(async () => {
      await inbox!.markAllRead().catch((error: unknown) => {
        failure = error;
      });
    });
    await settle();
    expect(failure).toBeTruthy();
    expect(inbox!.data?.notifications.map((n) => n.read)).toEqual([false, false, false, true]);
    expect(inbox!.unreadCount).toBe(3);
    await act(async () => {
      for (const request of held) request.respond(200, PAGE);
    });
  });
});

describe('useNotificationPreferences', () => {
  const PREFS: NotificationPreferences = { kinds: { ...DEFAULT_NOTIFICATION_PREFERENCES }, email_available: true };
  let prefs: ReturnType<typeof useNotificationPreferences>;
  function Prefs(props: { userId: string | null }) {
    prefs = useNotificationPreferences(props);
    return null;
  }

  test('no user: no request', async () => {
    await mount(React.createElement(Prefs, { userId: null }));
    expect(requests).toEqual([]);
    expect(prefs!.isLoading).toBe(false);
  });

  test('update applies the patch at once, PUTs it, then keeps the server record', async () => {
    const saved: NotificationPreferences = {
      kinds: { ...PREFS.kinds, turn_done: { push: false, email: false } },
      email_available: true,
    };
    answer = () => ({ status: 200, body: PREFS });
    await mount(React.createElement(Prefs, { userId: USER }));
    expect(requests[0]).toEqual({ method: 'GET', path: '/notifications/preferences', body: undefined });
    expect(client.getQueryData<NotificationPreferences>(qk.notifications.preferences(USER))).toEqual(PREFS);
    hold = (method) => method === 'PUT';
    let done!: Promise<unknown>;
    await act(async () => {
      done = prefs!.update({ kinds: { turn_done: { push: false } } });
    });
    await settle();
    expect(prefs!.data?.kinds.turn_done).toEqual({ push: false, email: false });
    expect(prefs!.data?.kinds.question).toEqual(PREFS.kinds.question);
    expect(held[0]).toMatchObject({
      method: 'PUT',
      path: '/notifications/preferences',
      body: { kinds: { turn_done: { push: false } } },
    });
    await act(async () => {
      held[0]!.respond(200, saved);
      await done;
    });
    expect(prefs!.data).toEqual(saved);
  });

  test('a rejected update restores the previous record', async () => {
    answer = (method) => (method === 'GET' ? { status: 200, body: PREFS } : { status: 500, body: { error: 'boom' } });
    await mount(React.createElement(Prefs, { userId: USER }));
    let failure: unknown = null;
    await act(async () => {
      await prefs!.update({ kinds: { question: { email: false } } }).catch((error: unknown) => {
        failure = error;
      });
    });
    await settle();
    expect(failure).toBeTruthy();
    expect(prefs!.data).toEqual(PREFS);
  });
});

describe('useSessionWatch', () => {
  let watch: ReturnType<typeof useSessionWatch>;
  function Watch(props: { userId: string | null; projectId: string; sessionId: string }) {
    watch = useSessionWatch(props);
    return null;
  }

  test('no user: no request', async () => {
    await mount(React.createElement(Watch, { userId: null, projectId: 'P1', sessionId: 'S1' }));
    expect(requests).toEqual([]);
    expect(watch!.isLoading).toBe(false);
  });

  test('reads the watch state under the user, project and session key', async () => {
    answer = () => ({ status: 200, body: { watching: true } });
    await mount(React.createElement(Watch, { userId: USER, projectId: 'P1', sessionId: 'S1' }));
    expect(requests).toEqual([{ method: 'GET', path: '/projects/P1/sessions/S1/watch', body: undefined }]);
    expect(watch!.data).toEqual({ watching: true });
    expect(client.getQueryData<{ watching: boolean }>(qk.notifications.sessionWatch(USER, 'P1', 'S1'))).toEqual({ watching: true });
  });

  test('setWatching flips the state at once and PUTs it', async () => {
    answer = () => ({ status: 200, body: { watching: true } });
    await mount(React.createElement(Watch, { userId: USER, projectId: 'P1', sessionId: 'S1' }));
    hold = (method) => method === 'PUT';
    let done!: Promise<unknown>;
    await act(async () => {
      done = watch!.setWatching(false);
    });
    await settle();
    expect(watch!.data).toEqual({ watching: false });
    expect(held[0]).toMatchObject({ method: 'PUT', path: '/projects/P1/sessions/S1/watch', body: { watching: false } });
    await act(async () => {
      held[0]!.respond(200, { watching: false });
      await done;
    });
    expect(watch!.data).toEqual({ watching: false });
  });

  test('a rejected write restores the previous state', async () => {
    answer = (method) => (method === 'GET' ? { status: 200, body: { watching: true } } : { status: 403, body: { error: 'no' } });
    await mount(React.createElement(Watch, { userId: USER, projectId: 'P1', sessionId: 'S1' }));
    let failure: unknown = null;
    await act(async () => {
      await watch!.setWatching(false).catch((error: unknown) => {
        failure = error;
      });
    });
    await settle();
    expect(failure).toBeTruthy();
    expect(watch!.data).toEqual({ watching: true });
  });
});
