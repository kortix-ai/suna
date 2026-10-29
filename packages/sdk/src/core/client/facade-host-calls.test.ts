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

test('notifications.releaseDeviceToken POSTs the token to the public release route (KRTX-2242)', async () => {
  await kortix.notifications.releaseDeviceToken('t');
  expect(calls).toEqual([
    { method: 'POST', url: 'http://test.local/v1/notifications/device-token/release', body: { device_token: 't' } },
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

test('session(pid, sid).setPinned and setArchived write the caller`s own list state', async () => {
  await kortix.session('P1', 'S1').setPinned(true);
  await kortix.session('P1', 'S1').setArchived(false);
  expect(calls).toEqual([
    { method: 'PUT', url: 'http://test.local/projects/P1/sessions/S1/pin', body: { pinned: true } },
    { method: 'PUT', url: 'http://test.local/projects/P1/sessions/S1/archive', body: { archived: false } },
  ]);
});

test('session(pid, sid).recover continues a lost session on a new computer', async () => {
  await kortix.session('P1', 'S1').recover();
  expect(calls).toEqual([{ method: 'POST', url: 'http://test.local/projects/P1/sessions/S1/recover', body: {} }]);
});

test('the root builds a sandbox proxy URL from an external id (mobile: no SandboxInfo in hand)', async () => {
  const root = await import('../../index');
  expect(root.getSandboxUrlForExternalId('ext-1', 6080)).toBe('http://test.local/p/ext-1/6080');
  expect(root.getSandboxUrlForExternalId('ext-1')).toBe('http://test.local/p/ext-1/8000');
});

test('project(id).triggers reaches run history, fire with a payload, and replay (KRTX-1743)', async () => {
  const t = kortix.project('P1').triggers;
  await t.runs('nightly', { limit: 5 });
  await t.projectRuns({ status: 'failed' });
  await t.fire('nightly', { dryRun: true });
  await t.replay('nightly', 'run-1');
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    'GET http://test.local/projects/P1/triggers/nightly/runs?limit=5',
    'GET http://test.local/projects/P1/trigger-runs?status=failed',
    'POST http://test.local/projects/P1/triggers/nightly/fire',
    'POST http://test.local/projects/P1/triggers/nightly/runs/run-1/replay',
  ]);
  expect(calls[2]!.body).toEqual({ dry_run: true });
});

test('project(id).spaces lists, creates, updates and opens a DM', async () => {
  const spaces = kortix.project('P1').spaces;
  await spaces.list();
  await spaces.create({ name: 'Design' });
  await spaces.update('S1', { name: 'Design team' });
  await spaces.dm('kortix');
  expect(calls).toEqual([
    { method: 'GET', url: 'http://test.local/projects/P1/spaces', body: undefined },
    { method: 'POST', url: 'http://test.local/projects/P1/spaces', body: { name: 'Design' } },
    { method: 'PATCH', url: 'http://test.local/projects/P1/spaces/S1', body: { name: 'Design team' } },
    { method: 'POST', url: 'http://test.local/projects/P1/spaces/dm', body: { agent_name: 'kortix' } },
  ]);
});

test('project(id).sessionGroups lists, creates, renames, reorders, deletes and files a session', async () => {
  const groups = kortix.project('P1').sessionGroups;
  await groups.list();
  await groups.create({ name: 'Store A' });
  await groups.rename('G1', 'Store A (EU)');
  await groups.reorder(['G2', 'G1']);
  await groups.delete('G2');
  await groups.file('S1', 'G1');
  await groups.file('S1', null);
  expect(calls).toEqual([
    { method: 'GET', url: 'http://test.local/projects/P1/session-groups', body: undefined },
    { method: 'POST', url: 'http://test.local/projects/P1/session-groups', body: { name: 'Store A' } },
    { method: 'PATCH', url: 'http://test.local/projects/P1/session-groups/G1', body: { name: 'Store A (EU)' } },
    { method: 'PUT', url: 'http://test.local/projects/P1/session-groups/order', body: { group_ids: ['G2', 'G1'] } },
    { method: 'DELETE', url: 'http://test.local/projects/P1/session-groups/G2', body: undefined },
    { method: 'PUT', url: 'http://test.local/projects/P1/sessions/S1/group', body: { group_id: 'G1' } },
    { method: 'PUT', url: 'http://test.local/projects/P1/sessions/S1/group', body: { group_id: null } },
  ]);
});

test('project(id).spaces.members lists, adds, removes, joins and leaves', async () => {
  const members = kortix.project('P1').spaces.members;
  await members.list('S1');
  await members.add('S1', ['U2']);
  await members.remove('S1', 'U2');
  await members.join('S1');
  await members.leave('S1');
  const base = 'http://test.local/projects/P1/spaces/S1';
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    `GET ${base}/members`,
    `POST ${base}/members`,
    `DELETE ${base}/members/U2`,
    `POST ${base}/join`,
    `DELETE ${base}/members/me`,
  ]);
});

test('project(id).memory reaches layers, pages and history', async () => {
  const memory = kortix.project('P1').memory;
  await memory.layer('company');
  await memory.pages.list('S1');
  await memory.pages.create('S1', { type: 'people', title: 'Priya' });
  await memory.notes.add('S1', { text: 'Priya owns the Northwind launch' });
  await memory.pages.get('PG1');
  await memory.pages.update('PG1', { base_version: 3, body: 'Owns QA' });
  await memory.pages.delete('PG1');
  await memory.pages.history('PG1');
  const base = 'http://test.local/projects/P1/memory';
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    `GET ${base}/layers/company`,
    `GET ${base}/layers/S1/pages`,
    `POST ${base}/layers/S1/pages`,
    `POST ${base}/layers/S1/notes`,
    `GET ${base}/pages/PG1`,
    `PATCH ${base}/pages/PG1`,
    `DELETE ${base}/pages/PG1`,
    `GET ${base}/pages/PG1/history`,
  ]);
  expect(calls[5]!.body).toEqual({ base_version: 3, body: 'Owns QA' });
});

test('project(id).memory searches pages and reads a thread’s Used memory', async () => {
  const memory = kortix.project('P1').memory;
  await memory.search({ q: 'Priya', layer: 'company' });
  await memory.usage('T1');
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    'GET http://test.local/projects/P1/memory/search?q=Priya&layer=company',
    'GET http://test.local/projects/P1/sessions/T1/memory-usage',
  ]);
});

test('project(id).memory filters pages by type', async () => {
  await kortix.project('P1').memory.pages.list('S1', { type: 'other' });
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET http://test.local/projects/P1/memory/layers/S1/pages?type=other']);
});

test('project(id).spaces reads #general\'s notice and the caller\'s onboarding, and records a mark', async () => {
  const spaces = kortix.project('P1').spaces;
  await spaces.generalNotice();
  await spaces.onboarding.get();
  await spaces.onboarding.mark('channels_intro');
  expect(calls).toEqual([
    { method: 'GET', url: 'http://test.local/projects/P1/spaces', body: undefined },
    { method: 'GET', url: 'http://test.local/projects/P1/onboarding/channels', body: undefined },
    { method: 'POST', url: 'http://test.local/projects/P1/onboarding/channels/marks', body: { mark: 'channels_intro' } },
  ]);
});

test('project(id).spaces reaches a channel’s apps and links', async () => {
  const spaces = kortix.project('P1').spaces;
  await spaces.apps('S1');
  await spaces.links.list('S1');
  await spaces.links.add('S1', { url: 'https://example.test' });
  await spaces.links.remove('S1', 'L1');
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    'GET http://test.local/projects/P1/spaces/S1/apps',
    'GET http://test.local/projects/P1/spaces/S1/links',
    'POST http://test.local/projects/P1/spaces/S1/links',
    'DELETE http://test.local/projects/P1/spaces/S1/links/L1',
  ]);
  expect(calls[2]!.body).toEqual({ url: 'https://example.test' });
});
