import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as shared from '../../../../../shared/src/notification-kinds';
import { configureKortix } from '../../http/config';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  INBOX_NOTIFICATION_KINDS,
  getNotificationPreferences,
  getWebPushPublicKey,
  listNotifications,
  markNotificationsRead,
  registerDeviceToken,
  registerWebPushSubscription,
  unregisterDeviceToken,
  unregisterWebPushSubscription,
  updateNotificationPreferences,
  type InboxNotification,
  type InboxNotificationKind,
  type InboxNotificationPage,
  type NotificationPreferences,
} from './notifications';

let calls: { url: string; method: string; body: unknown }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok' });

test('registerDeviceToken POSTs the token, platform and preferences', async () => {
  nextResponse = { status: 200, body: { success: true, message: 'Device token registered' } };
  const result = await registerDeviceToken({
    device_token: 'ExponentPushToken[abc]',
    device_type: 'ios',
    provider: 'expo',
    preferences: { enabled: true, on_question: false },
  });
  expect(calls[0]).toMatchObject({
    url: 'http://test.local/v1/notifications/device-token',
    method: 'POST',
    body: {
      device_token: 'ExponentPushToken[abc]',
      device_type: 'ios',
      provider: 'expo',
      preferences: { enabled: true, on_question: false },
    },
  });
  expect(result).toEqual({ success: true, message: 'Device token registered' });
});

test('unregisterDeviceToken DELETEs the encoded token', async () => {
  nextResponse = { status: 200, body: { success: true, deleted: true } };
  const result = await unregisterDeviceToken('ExponentPushToken[a/b]');
  expect(calls[0]?.url).toBe('http://test.local/v1/notifications/device-token/ExponentPushToken%5Ba%2Fb%5D');
  expect(calls[0]?.method).toBe('DELETE');
  expect(result).toEqual({ success: true, deleted: true });
});

test('unregisterDeviceToken honours the caller abort signal (the sign-out deadline)', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(unregisterDeviceToken('t', { signal: controller.signal })).rejects.toBeTruthy();
  expect(calls).toHaveLength(0);
});

test('registerDeviceToken throws on a 403 (a service account cannot bind a device)', async () => {
  nextResponse = { status: 403, body: { error: true, message: 'Device tokens require a signed-in user' } };
  await expect(
    registerDeviceToken({ device_token: 't', device_type: 'android', provider: 'expo' }),
  ).rejects.toBeTruthy();
});

// ── Inbox, preferences and Web Push (KRTX-1742) ─────────────────────────────

const ROW: InboxNotification = {
  id: '0192a000-0000-7000-8000-000000000001',
  kind: 'turn_done',
  title: 'Refactor the parser',
  body: '',
  project_id: 'P1',
  project_name: 'Synthetic project',
  session_id: 'S1',
  trigger_slug: null,
  actor_user_id: null,
  url: '/projects/P1/sessions/S1?notification=0192a000-0000-7000-8000-000000000001',
  read: false,
  created_at: '2026-10-09T10:00:00.000Z',
};
const PAGE: InboxNotificationPage = { notifications: [ROW], unread_count: 1, next_before: null };
const PREFERENCES: NotificationPreferences = {
  kinds: { ...DEFAULT_NOTIFICATION_PREFERENCES },
  email_available: true,
};

/** Configure an `onError` spy: a polled read must never reach the host's error toast. */
function withErrorSpy() {
  const onError = mock(() => {});
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok', onError });
  return onError;
}

describe('listNotifications', () => {
  test('GETs the first page with no query when no option is set', async () => {
    nextResponse = { status: 200, body: PAGE };
    const page = await listNotifications();
    expect(calls[0]).toMatchObject({ url: 'http://test.local/v1/notifications', method: 'GET' });
    expect(page).toEqual(PAGE);
  });

  test('sends limit and the before cursor, encoded', async () => {
    nextResponse = { status: 200, body: PAGE };
    await listNotifications({ limit: 50, before: 'a b/c' });
    expect(calls[0]?.url).toBe('http://test.local/v1/notifications?limit=50&before=a+b%2Fc');
  });

  test('a failed poll rejects without calling the host error handler', async () => {
    const onError = withErrorSpy();
    nextResponse = { status: 500, body: { error: 'boom' } };
    await expect(listNotifications()).rejects.toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
  });

  test('a 403 (a service account has no inbox) rejects', async () => {
    nextResponse = { status: 403, body: { error: 'Notifications require a signed-in user' } };
    await expect(listNotifications()).rejects.toBeTruthy();
  });

  test('honours the caller abort signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(listNotifications({}, { signal: controller.signal })).rejects.toBeTruthy();
    expect(calls).toHaveLength(0);
  });
});

describe('markNotificationsRead', () => {
  test('POSTs the ids', async () => {
    nextResponse = { status: 200, body: { updated: 2, unread_count: 3 } };
    const result = await markNotificationsRead({ ids: ['n1', 'n2'] });
    expect(calls[0]).toEqual({
      url: 'http://test.local/v1/notifications/read',
      method: 'POST',
      body: { ids: ['n1', 'n2'] },
    });
    expect(result).toEqual({ updated: 2, unread_count: 3 });
  });

  test('POSTs all: true', async () => {
    nextResponse = { status: 200, body: { updated: 9, unread_count: 0 } };
    await markNotificationsRead({ all: true });
    expect(calls[0]?.body).toEqual({ all: true });
  });

  test('sends sessionId as session_id on the wire', async () => {
    nextResponse = { status: 200, body: { updated: 1, unread_count: 0 } };
    await markNotificationsRead({ sessionId: 'S1' });
    expect(calls[0]?.body).toEqual({ session_id: 'S1' });
  });

  test('a 403 rejects', async () => {
    nextResponse = { status: 403, body: { error: 'Notifications require a signed-in user' } };
    await expect(markNotificationsRead({ all: true })).rejects.toBeTruthy();
  });
});

describe('notification preferences', () => {
  test('getNotificationPreferences GETs the record without an error toast on failure', async () => {
    nextResponse = { status: 200, body: PREFERENCES };
    expect(await getNotificationPreferences()).toEqual(PREFERENCES);
    expect(calls[0]).toMatchObject({ url: 'http://test.local/v1/notifications/preferences', method: 'GET' });
    const onError = withErrorSpy();
    nextResponse = { status: 500, body: { error: 'boom' } };
    await expect(getNotificationPreferences()).rejects.toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
  });

  test('updateNotificationPreferences PUTs the partial patch and returns the effective record', async () => {
    nextResponse = { status: 200, body: PREFERENCES };
    const result = await updateNotificationPreferences({ kinds: { turn_done: { push: false } } });
    expect(calls[0]).toEqual({
      url: 'http://test.local/v1/notifications/preferences',
      method: 'PUT',
      body: { kinds: { turn_done: { push: false } } },
    });
    expect(result).toEqual(PREFERENCES);
  });

  test('updateNotificationPreferences rejects on a 400', async () => {
    nextResponse = { status: 400, body: { error: 'Invalid body' } };
    await expect(updateNotificationPreferences({ kinds: {} })).rejects.toBeTruthy();
  });
});

describe('Web Push subscriptions', () => {
  const endpoint = 'https://fcm.googleapis.com/fcm/send/abc:def?x=1&y=2';

  test('getWebPushPublicKey GETs the server key', async () => {
    nextResponse = { status: 200, body: { public_key: 'BPublicKey' } };
    expect(await getWebPushPublicKey()).toEqual({ public_key: 'BPublicKey' });
    expect(calls[0]).toMatchObject({ url: 'http://test.local/v1/notifications/web-push/key', method: 'GET' });
  });

  test('registerWebPushSubscription POSTs only the endpoint and the two keys', async () => {
    nextResponse = { status: 200, body: { ok: true } };
    // A browser's `PushSubscription.toJSON()` also carries `expirationTime`.
    const fromBrowser = { endpoint, expirationTime: null, keys: { p256dh: 'BKey', auth: 'AuthSecret' } };
    expect(await registerWebPushSubscription(fromBrowser)).toEqual({ ok: true });
    expect(calls[0]).toEqual({
      url: 'http://test.local/v1/notifications/web-push/subscriptions',
      method: 'POST',
      body: { endpoint, keys: { p256dh: 'BKey', auth: 'AuthSecret' } },
    });
  });

  test('registerWebPushSubscription rejects on a 403 (a personal token cannot subscribe)', async () => {
    nextResponse = { status: 403, body: { error: 'Web Push requires a browser sign-in' } };
    await expect(
      registerWebPushSubscription({ endpoint, keys: { p256dh: 'BKey', auth: 'AuthSecret' } }),
    ).rejects.toBeTruthy();
  });

  test('Web Push sync runs in the background: a failure rejects without the host error toast', async () => {
    const onError = withErrorSpy();
    nextResponse = { status: 500, body: { error: 'boom' } };
    await expect(getWebPushPublicKey()).rejects.toBeTruthy();
    nextResponse = { status: 500, body: { error: 'boom' } };
    await expect(registerWebPushSubscription({ endpoint, keys: { p256dh: 'BKey', auth: 'AuthSecret' } })).rejects.toBeTruthy();
    nextResponse = { status: 500, body: { error: 'boom' } };
    await expect(unregisterWebPushSubscription(endpoint)).rejects.toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
  });

  test('unregisterWebPushSubscription DELETEs with the endpoint encoded as a query value', async () => {
    nextResponse = { status: 200, body: { deleted: true } };
    expect(await unregisterWebPushSubscription(endpoint)).toEqual({ deleted: true });
    expect(calls[0]).toMatchObject({
      method: 'DELETE',
      url: `http://test.local/v1/notifications/web-push/subscriptions?endpoint=${encodeURIComponent(endpoint)}`,
    });
    expect(new URL(calls[0]!.url).searchParams.get('endpoint')).toBe(endpoint);
  });

  test('unregisterWebPushSubscription honours the caller abort signal (the sign-out deadline)', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(unregisterWebPushSubscription(endpoint, { signal: controller.signal })).rejects.toBeTruthy();
    expect(calls).toHaveLength(0);
  });
});

// `@kortix/sdk` is published and cannot import the private `@kortix/shared`.
// It keeps its own copy of the kinds and defaults; this test holds the two equal.
describe('kind parity with @kortix/shared/notification-kinds', () => {
  test('the SDK kinds equal the shared kinds, in order', () => {
    expect([...INBOX_NOTIFICATION_KINDS]).toEqual([...shared.NOTIFICATION_KINDS]);
  });

  test('the SDK defaults equal the shared defaults', () => {
    expect(DEFAULT_NOTIFICATION_PREFERENCES).toEqual(shared.DEFAULT_NOTIFICATION_PREFERENCES);
  });

  test('the kind unions are the same type', () => {
    const toShared = (kind: InboxNotificationKind): shared.NotificationKindName => kind;
    const toSdk = (kind: shared.NotificationKindName): InboxNotificationKind => kind;
    expect(toShared(toSdk('question'))).toBe('question');
  });
});
