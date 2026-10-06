import { beforeEach, expect, mock, test } from 'bun:test';
import { createKortix } from '../../client/kortix';
import { configureKortix } from '../../http/config';
import {
  approveCaptureDeviceGrant,
  getCaptureWorkspace,
  getMyCaptureFrame,
  getMyCaptureTimeline,
  listCaptureMembers,
  searchMyCapture,
  setCaptureEnabled,
  setCaptureMemberRole,
  denyCaptureDeviceGrant,
  getCaptureAssetUrl,
  getCaptureChunkMedia,
  getCaptureDays,
  getCaptureDeviceGrant,
  getCaptureFrame,
  getCapturePeople,
  getCapturePolicy,
  getCaptureRange,
  getCaptureTimeline,
  getCaptureTimelineItems,
  listCaptureDevices,
  listCaptureRanges,
  processCaptureRange,
  revokeCaptureDevice,
  syncCaptureDevice,
  saveCaptureRange,
  searchCapture,
  setCaptureDevicePolicy,
  setCapturePolicy,
  type CapturePolicy,
} from './capture';

let calls: { url: string; method: string; body: unknown }[] = [];
let nextBody: unknown = {};

beforeEach(() => {
  calls = [];
  nextBody = {};
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({ url: String(url), method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    return new Response(JSON.stringify(nextBody), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1]!;
// Capture's tenant is the Kortix account: every route is under /accounts/:accountId/capture.
const P = 'http://test.local/accounts/a1/capture';

const POLICY: CapturePolicy = {
  layers: { screen: true, actions: true, audio: false },
  privacy: { redact_pii: true },
  retention: { local_hours: 24, remote_days: 30 },
  recording: { paused: false, paused_until_ms: null },
  notice: 'Recording is on for the support team.',
};

test('devices: list mine, a member, or the account; revoke; set and clear a device override', async () => {
  nextBody = { devices: [{ device_id: 'd1', live: { state: 'recording' } }] };
  const mine = await listCaptureDevices('a1');
  expect(last()).toMatchObject({ method: 'GET', url: `${P}/devices` });
  expect(mine.devices[0]?.live.state).toBe('recording');
  await listCaptureDevices('a1', { userId: 'u2' });
  expect(last().url).toBe(`${P}/devices?user_id=u2`);
  await listCaptureDevices('a1', { scope: 'account' });
  expect(last().url).toBe(`${P}/devices?scope=account`);
  await revokeCaptureDevice('a1', 'd1');
  expect(last()).toMatchObject({ method: 'DELETE', url: `${P}/devices/d1` });
  nextBody = { device_id: 'd1', enqueued: 3, forgotten: 1 };
  const synced = await syncCaptureDevice('a1', 'd1');
  expect([synced.enqueued, synced.forgotten]).toEqual([3, 1]);
  expect(last()).toMatchObject({ method: 'POST', url: `${P}/devices/d1/sync` });
  await setCaptureDevicePolicy('a1', 'd1', POLICY);
  expect(last()).toMatchObject({ method: 'PUT', url: `${P}/devices/d1/policy`, body: { policy: POLICY } });
  await setCaptureDevicePolicy('a1', 'd1', null);
  expect(last().body).toEqual({ policy: null });
});

test('policy: read and write the account policy', async () => {
  nextBody = { policy: POLICY, updated_at: null, updated_by: null };
  expect((await getCapturePolicy('a1')).policy.retention.remote_days).toBe(30);
  expect(last()).toMatchObject({ method: 'GET', url: `${P}/policy` });
  await setCapturePolicy('a1', POLICY);
  expect(last()).toMatchObject({ method: 'PUT', url: `${P}/policy`, body: { policy: POLICY } });
});

test('timeline: a day, a window, and its items; the query names the subject and device', async () => {
  nextBody = { user_id: 'u1', runs: [], chunks: [], ranges: [] };
  await getCaptureTimeline('a1', { day: '2026-10-03' });
  expect(last().url).toBe(`${P}/timeline?day=2026-10-03`);
  await getCaptureTimeline('a1', { from: '2026-10-03T09:00:00.000Z', to: '2026-10-03T10:00:00.000Z', userId: 'u2', deviceId: 'd1' });
  expect(last().url).toBe(`${P}/timeline?from=2026-10-03T09%3A00%3A00.000Z&to=2026-10-03T10%3A00%3A00.000Z&user_id=u2&device_id=d1`);
  await getCaptureTimelineItems('a1', { day: '2026-10-03' });
  expect(last().url).toBe(`${P}/timeline/items?day=2026-10-03`);
});

test('recorded days: grouped in the caller’s time zone, for a member or one device', async () => {
  nextBody = { user_id: 'u1', tz: 'Europe/Berlin', days: [{ day: '2026-10-03', start_at: 'a', end_at: 'b', screen_seconds: 600 }] };
  const result = await getCaptureDays('a1', { tz: 'Europe/Berlin' });
  expect(last()).toMatchObject({ method: 'GET', url: `${P}/days?tz=Europe%2FBerlin` });
  expect(result.days[0]?.screen_seconds).toBe(600);
  await getCaptureDays('a1', { userId: 'u2', deviceId: 'd1' });
  expect(last().url).toBe(`${P}/days?user_id=u2&device_id=d1`);
  await getCaptureDays('a1');
  expect(last().url).toBe(`${P}/days`);
});

test('search: query, kinds, app and limit are sent; hits come back newest first', async () => {
  nextBody = { user_id: 'u1', q: 'invoice', hits: [{ kind: 'screen', id: 'f1', snippet: 'Invoice 1042' }] };
  const result = await searchCapture('a1', { q: 'invoice 1042', kinds: ['screen', 'audio'], app: 'Mail', limit: 5 });
  expect(last().url).toBe(`${P}/search?q=invoice+1042&kinds=screen%2Caudio&app=Mail&limit=5`);
  expect(result.hits[0]?.kind).toBe('screen');
});

test('search: an admin searches the whole account (scope=account); each hit names its person; a frame carries its nearest screenshot', async () => {
  nextBody = { user_id: null, q: 'refund', hits: [{ kind: 'actions', id: 'a1', user_id: 'u2', snippet: 'Type refund' }] };
  const result = await searchCapture('a1', { q: 'refund', scope: 'account' });
  expect(last().url).toBe(`${P}/search?q=refund&scope=account`);
  const who: string = result.hits[0]!.user_id;
  expect(who).toBe('u2');
  nextBody = { frame: { frame_id: 'f1' }, video: null, screenshot: { name: 'sha256-x.jpg', ts: 't', url: 'https://s3.test/s', expires_at: 'e' } };
  const frame = await getCaptureFrame('a1', 'f1');
  const shot: string | undefined = frame.screenshot?.url;
  expect(shot).toBe('https://s3.test/s');
});

test('media: a frame with its video URL, an item’s media, an asset URL', async () => {
  nextBody = { frame: { frame_id: 'f1' }, video: { url: 'https://s3.test/v', offset_ms: 1000, expires_at: 'x', encrypted: false } };
  expect((await getCaptureFrame('a1', 'f1')).video?.offset_ms).toBe(1000);
  expect(last().url).toBe(`${P}/frames/f1`);
  await getCaptureFrame('a1', 'f1', { userId: 'u2' });
  expect(last().url).toBe(`${P}/frames/f1?user_id=u2`);
  await getCaptureChunkMedia('a1', 'c1');
  expect(last().url).toBe(`${P}/chunks/c1/media`);
  await getCaptureAssetUrl('a1', 'd1', `sha256-${'a'.repeat(64)}.png`);
  expect(last().url).toBe(`${P}/devices/d1/assets/sha256-${'a'.repeat(64)}.png`);
});

test('ranges: list, save, read with outputs, process again', async () => {
  nextBody = { ranges: [] };
  await listCaptureRanges('a1', { day: '2026-10-03' });
  expect(last().url).toBe(`${P}/ranges?day=2026-10-03`);
  nextBody = { range_id: 'r1', status: 'closed' };
  await saveCaptureRange('a1', { start_at: '2026-10-03T09:00:00.000Z', end_at: '2026-10-03T09:30:00.000Z', title: 'Budget review' });
  expect(last()).toMatchObject({ method: 'POST', url: `${P}/ranges`, body: { title: 'Budget review' } });
  nextBody = { range_id: 'r1', outputs: [{ kind: 'segmentation', status: 'done' }] };
  expect((await getCaptureRange('a1', 'r1')).outputs[0]?.kind).toBe('segmentation');
  await processCaptureRange('a1', 'r1');
  expect(last()).toMatchObject({ method: 'POST', url: `${P}/ranges/r1/process` });
});

test('people: the managers’ per-member summary', async () => {
  nextBody = { from: 'a', to: 'b', people: [{ user_id: 'u1', active_seconds: 60, apps: [{ app: 'Mail', seconds: 60 }], ranges: 1, devices: 1 }] };
  expect((await getCapturePeople('a1', { day: '2026-10-03' })).people[0]?.active_seconds).toBe(60);
  expect(last().url).toBe(`${P}/people?day=2026-10-03`);
});

test('workspace: read it, turn Capture on, list and set Capture roles', async () => {
  nextBody = { account_id: 'a1', enabled: false, role: 'admin', can_manage: true, updated_at: null };
  expect((await getCaptureWorkspace('a1')).can_manage).toBe(true);
  expect(last()).toMatchObject({ method: 'GET', url: P });
  await setCaptureEnabled('a1', true);
  expect(last()).toMatchObject({ method: 'PATCH', url: P, body: { enabled: true } });
  nextBody = { members: [{ user_id: 'u1', account_role: 'owner', role: 'admin', overridden: false }] };
  expect((await listCaptureMembers('a1')).members[0]?.role).toBe('admin');
  expect(last()).toMatchObject({ method: 'GET', url: `${P}/members` });
  await setCaptureMemberRole('a1', 'u2', 'viewer');
  expect(last()).toMatchObject({ method: 'PUT', url: `${P}/members/u2`, body: { role: 'viewer' } });
  await setCaptureMemberRole('a1', 'u2', null);
  expect(last().body).toEqual({ role: null });
});

test('device sign-in approval: read with the accounts it can sign into, approve into an account, deny', async () => {
  nextBody = { user_code: 'ABCD-1234', status: 'pending', device: { name: 'Laptop' }, account_id: null, accounts: [{ account_id: 'a1', name: 'Acme' }] };
  const grant = await getCaptureDeviceGrant('abcd-1234');
  expect([grant.status, grant.accounts[0]?.account_id]).toEqual(['pending', 'a1']);
  expect(last()).toMatchObject({ method: 'GET', url: 'http://test.local/capture/device/grants/abcd-1234' });
  await approveCaptureDeviceGrant('ABCD-1234', 'a1');
  expect(last()).toMatchObject({ method: 'POST', url: 'http://test.local/capture/device/grants/ABCD-1234/approve', body: { account_id: 'a1' } });
  // Without an account, the API picks the caller's one account with Capture on.
  await approveCaptureDeviceGrant('ABCD-1234');
  expect(last().body).toEqual({});
  await denyCaptureDeviceGrant('ABCD-1234');
  expect(last()).toMatchObject({ method: 'POST', url: 'http://test.local/capture/device/grants/ABCD-1234/deny' });
});

test('the agent tool reads the person it acts for under /capture/me, account from the token', async () => {
  nextBody = { hits: [] };
  await searchMyCapture({ q: 'invoice', kinds: ['audio'] });
  expect(last()).toMatchObject({ method: 'GET', url: 'http://test.local/capture/me/search?q=invoice&kinds=audio' });
  nextBody = { runs: [], chunks: [], ranges: [] };
  await getMyCaptureTimeline({ day: '2026-10-03' });
  expect(last().url).toBe('http://test.local/capture/me/timeline?day=2026-10-03');
  nextBody = { frame: { frame_id: 'f1' }, video: null };
  await getMyCaptureFrame('f1');
  expect(last().url).toBe('http://test.local/capture/me/frames/f1');
});

test('the facade binds Capture to an account; sign-in approval and the agent reads sit beside it', async () => {
  const kortix = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  const capture = kortix.capture.account('a1');
  nextBody = { hits: [] };
  await capture.search({ q: 'forecast' });
  expect(last().url).toBe(`${P}/search?q=forecast`);
  await capture.devices.list({ scope: 'account' });
  expect(last().url).toBe(`${P}/devices?scope=account`);
  await capture.timeline.get({ day: '2026-10-03' });
  expect(last().url).toBe(`${P}/timeline?day=2026-10-03`);
  await capture.timeline.days({ tz: 'UTC' });
  expect(last().url).toBe(`${P}/days?tz=UTC`);
  await capture.devices.sync('d1');
  expect(last().url).toBe(`${P}/devices/d1/sync`);
  await capture.ranges.process('r1');
  expect(last().url).toBe(`${P}/ranges/r1/process`);
  await capture.workspace.setEnabled(true);
  expect(last()).toMatchObject({ method: 'PATCH', url: P });
  await capture.members.set('u2', 'member');
  expect(last().url).toBe(`${P}/members/u2`);
  await kortix.capture.approveDevice('ABCD-1234', 'a1');
  expect(last().url).toBe('http://test.local/capture/device/grants/ABCD-1234/approve');
  await kortix.capture.me.search({ q: 'x' });
  expect(last().url).toBe('http://test.local/capture/me/search?q=x');
  // No project anywhere in Capture.
  expect('capture' in kortix.project('p1')).toBe(false);
});
