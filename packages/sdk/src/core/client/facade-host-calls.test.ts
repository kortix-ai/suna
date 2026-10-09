import { beforeEach, expect, mock, test } from 'bun:test';
import { createKortix } from './kortix';

// The REST calls a host used to hand-roll (mobile, R5.4) are reachable from the facade.
let calls: { url: string; method: string; body?: unknown }[] = [];
beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({ url: String(url), method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    return new Response(JSON.stringify({ ok: true, success: true, stage: 'provisioning' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

const kortix = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

test('project(id).connectors.deleteCredential disconnects the connector', async () => {
  await kortix.project('P1').connectors.deleteCredential('gmail');
  expect(calls[0]).toMatchObject({ method: 'DELETE', url: 'http://test.local/connectors/projects/P1/connectors/gmail/credential' });
});

test('project(id).changeRequests.update edits the title', async () => {
  await kortix.project('P1').changeRequests.update('cr-1', { title: 'T' });
  expect(calls[0]).toEqual({ method: 'PATCH', url: 'http://test.local/projects/P1/change-requests/cr-1', body: { title: 'T' } });
});

test('project(id).files.archiveRequest names the archive download', async () => {
  const request = await kortix.project('P1').files.archiveRequest('main');
  expect(request.url).toBe('http://test.local/projects/P1/files/archive?ref=main');
});

test('session(pid, sid).startOrThrow POSTs /start', async () => {
  await kortix.session('P1', 'S1').startOrThrow();
  expect(calls[0]).toMatchObject({ method: 'POST', url: 'http://test.local/projects/P1/sessions/S1/start' });
});

test('notifications register and unregister a push device token', async () => {
  await kortix.notifications.registerDeviceToken({ device_token: 't', device_type: 'ios', provider: 'expo' });
  await kortix.notifications.unregisterDeviceToken('t');
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    'POST http://test.local/notifications/device-token',
    'DELETE http://test.local/notifications/device-token/t',
  ]);
});

test('notifications reach the inbox, preferences and Web Push routes (KRTX-1742)', async () => {
  const n = kortix.notifications;
  await n.list({ limit: 20 });
  await n.markRead({ sessionId: 'S1' });
  await n.preferences();
  await n.updatePreferences({ kinds: { question: { email: false } } });
  await n.webPushPublicKey();
  await n.registerWebPushSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'k', auth: 'a' } });
  await n.unregisterWebPushSubscription('https://fcm.googleapis.com/fcm/send/x');
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    'GET http://test.local/notifications?limit=20',
    'POST http://test.local/notifications/read',
    'GET http://test.local/notifications/preferences',
    'PUT http://test.local/notifications/preferences',
    'GET http://test.local/notifications/web-push/key',
    'POST http://test.local/notifications/web-push/subscriptions',
    `DELETE http://test.local/notifications/web-push/subscriptions?endpoint=${encodeURIComponent('https://fcm.googleapis.com/fcm/send/x')}`,
  ]);
  expect(calls[1]?.body).toEqual({ session_id: 'S1' });
});

test('session(pid, sid).watch and setWatch read and write the caller watch', async () => {
  await kortix.session('P1', 'S1').watch();
  await kortix.session('P1', 'S1').setWatch(false);
  expect(calls).toEqual([
    { method: 'GET', url: 'http://test.local/projects/P1/sessions/S1/watch', body: undefined },
    { method: 'PUT', url: 'http://test.local/projects/P1/sessions/S1/watch', body: { watching: false } },
  ]);
});

test('the root builds a sandbox proxy URL from an external id (mobile: no SandboxInfo in hand)', async () => {
  const root = await import('../../index');
  expect(root.getSandboxUrlForExternalId('ext-1', 6080)).toBe('http://test.local/p/ext-1/6080');
  expect(root.getSandboxUrlForExternalId('ext-1')).toBe('http://test.local/p/ext-1/8000');
});
