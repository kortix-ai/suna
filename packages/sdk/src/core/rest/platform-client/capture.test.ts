import { beforeEach, expect, mock, test } from 'bun:test';
import { createKortix } from '../../client/kortix';
import { configureKortix } from '../../http/config';
import {
  approveCaptureDeviceGrant,
  getCaptureWorkspace,
  getMyCaptureFrame,
  getMyCaptureTimeline,
  searchMyCapture,
  setCaptureEnabled,
  denyCaptureDeviceGrant,
  getCaptureAssetUrl,
  getCaptureChunkMedia,
  getCaptureDays,
  getCaptureDeviceGrant,
  getCaptureFrame,
  getCapturePolicy,
  getCaptureTimeline,
  type CaptureDisplay,
  type CaptureFocusSpan,
  type CaptureTimeline,
  getCaptureTimelineItems,
  listCaptureDevices,
  revokeCaptureDevice,
  searchCapture,
  setCapturePolicy,
  type CaptureDevice,
  type CapturePolicy,
  captureHealthBucket,
} from './capture';
import * as Capture from './capture';

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
  privacy: {
    redact_pii: true,
    excluded_bundle_ids: ['com.apple.keychainaccess'],
    excluded_domains: ['bank.example.com'],
    exclusion_groups: ['password_managers', 'banking'],
    exclude_private_browsing: true,
  },
  retention: { local_hours: 24, remote_days: 30 },
  recording: { paused: false, paused_until_ms: null },
  notice: 'Recording is on for the support team.',
};

test('devices: list mine, a member, or the account; revoke', async () => {
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
});

test('raw capture only: no ranges, people, Capture roles, device sync or per-device policy', () => {
  for (const name of [
    'listCaptureRanges',
    'saveCaptureRange',
    'getCaptureRange',
    'processCaptureRange',
    'getCapturePeople',
    'listCaptureMembers',
    'setCaptureMemberRole',
    'syncCaptureDevice',
    'setCaptureDevicePolicy',
  ]) {
    expect(name in Capture).toBe(false);
  }
});

test('policy: read and write the account policy', async () => {
  nextBody = { policy: POLICY, updated_at: null, updated_by: null };
  expect((await getCapturePolicy('a1')).policy.retention.remote_days).toBe(30);
  expect(last()).toMatchObject({ method: 'GET', url: `${P}/policy` });
  await setCapturePolicy('a1', POLICY);
  expect(last()).toMatchObject({ method: 'PUT', url: `${P}/policy`, body: { policy: POLICY } });
  expect((last().body as { policy: CapturePolicy }).policy.privacy.exclusion_groups).toEqual(['password_managers', 'banking']);
  // The experimental switch that shows the privacy controls travels with the policy.
  await setCapturePolicy('a1', { ...POLICY, experimental: { privacy_controls: true } });
  expect((last().body as { policy: CapturePolicy }).policy.experimental).toEqual({ privacy_controls: true });
  // Record only included apps and websites travels in privacy.
  const recordOnly: CapturePolicy = {
    ...POLICY,
    privacy: { ...POLICY.privacy, record_only_included: true, included_bundle_ids: ['com.tinyspeck.slackmacgap'], included_domains: ['github.com'] },
  };
  await setCapturePolicy('a1', recordOnly);
  expect((last().body as { policy: CapturePolicy }).policy.privacy).toMatchObject({
    record_only_included: true,
    included_bundle_ids: ['com.tinyspeck.slackmacgap'],
    included_domains: ['github.com'],
  });
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

test('multiple displays: one display or every display; the timeline lists displays and focus spans', async () => {
  const display: CaptureDisplay = { id: 2, name: 'External Display', x: 1512, y: 0, w: 2560, h: 1440, scale: 1, main: false };
  const focus: CaptureFocusSpan = { device_id: 'd1', display_id: 1, start_at: '2026-10-03T09:00:00.000Z', end_at: '2026-10-03T09:05:00.000Z' };
  nextBody = { user_id: 'u1', from: '', to: '', displays: [display], focus: [focus], runs: [], chunks: [] } satisfies CaptureTimeline;
  const timeline = await getCaptureTimeline('a1', { day: '2026-10-03', deviceId: 'd1', displayId: 2 });
  expect(last().url).toBe(`${P}/timeline?day=2026-10-03&device_id=d1&display_id=2`);
  expect(timeline.displays[0]!.name).toBe('External Display');
  await getCaptureTimelineItems('a1', { day: '2026-10-03', displayId: 'all' });
  expect(last().url).toBe(`${P}/timeline/items?day=2026-10-03&display_id=all`);
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
  // A computer linked to no one is read as itself: the media and frame reads name the device.
  await getCaptureChunkMedia('a1', 'c1', { deviceId: 'd1' });
  expect(last().url).toBe(`${P}/chunks/c1/media?device_id=d1`);
  await getCaptureFrame('a1', 'f1', { deviceId: 'd1' });
  expect(last().url).toBe(`${P}/frames/f1?device_id=d1`);
  await getCaptureAssetUrl('a1', 'd1', `sha256-${'a'.repeat(64)}.png`);
  expect(last().url).toBe(`${P}/devices/d1/assets/sha256-${'a'.repeat(64)}.png`);
});

test('workspace: read it with what IAM lets you do, turn Capture on', async () => {
  nextBody = { account_id: 'a1', enabled: false, can_read_all: true, can_manage: true, updated_at: null };
  const workspace = await getCaptureWorkspace('a1');
  expect([workspace.can_read_all, workspace.can_manage]).toEqual([true, true]);
  expect('role' in workspace).toBe(false);
  expect(last()).toMatchObject({ method: 'GET', url: P });
  await setCaptureEnabled('a1', true);
  expect(last()).toMatchObject({ method: 'PATCH', url: P, body: { enabled: true } });
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
  nextBody = { runs: [], chunks: [] };
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
  await capture.workspace.setEnabled(true);
  expect(last()).toMatchObject({ method: 'PATCH', url: P });
  // Raw capture only: the account handle has nothing else.
  expect(Object.keys(capture).sort()).toEqual(['devices', 'enrollment', 'frame', 'media', 'policy', 'search', 'timeline', 'workspace']);
  expect(Object.keys(capture.devices).sort()).toEqual(['assetUrl', 'link', 'list', 'revoke']);
  await kortix.capture.approveDevice('ABCD-1234', 'a1');
  expect(last().url).toBe('http://test.local/capture/device/grants/ABCD-1234/approve');
  await kortix.capture.me.search({ q: 'x' });
  expect(last().url).toBe('http://test.local/capture/me/search?q=x');
  // No project anywhere in Capture.
  expect('capture' in kortix.project('p1')).toBe(false);
});

test('enrollment: tokens for an IT rollout, and the computers that wait for an admin', async () => {
  nextBody = { tokens: [{ token_id: 't1', state: 'active', device_count: 3 }] };
  const listed = await Capture.listCaptureEnrollmentTokens('a1');
  expect(last()).toMatchObject({ method: 'GET', url: `${P}/enrollment-tokens` });
  expect(listed.tokens[0]?.device_count).toBe(3);

  nextBody = { token_id: 't2', token: 'kortix_enr_x' };
  const created = await Capture.createCaptureEnrollmentToken('a1', {
    name: 'Pilot laptops',
    email_domains: ['corp.example'],
    max_devices: 20,
    require_approval: false,
    expires_in_days: 14,
  });
  expect(last()).toMatchObject({
    method: 'POST',
    url: `${P}/enrollment-tokens`,
    body: { name: 'Pilot laptops', email_domains: ['corp.example'], max_devices: 20, require_approval: false, expires_in_days: 14 },
  });
  expect(created.token).toBe('kortix_enr_x');

  // A personal token: every computer it enrolls is linked to this member.
  await Capture.createCaptureEnrollmentToken('a1', { name: 'Jane laptop', user_id: 'u7' });
  expect(last()).toMatchObject({ method: 'POST', url: `${P}/enrollment-tokens`, body: { name: 'Jane laptop', user_id: 'u7' } });

  await Capture.revokeCaptureEnrollmentToken('a1', 't2');
  expect(last()).toMatchObject({ method: 'DELETE', url: `${P}/enrollment-tokens/t2` });

  nextBody = { enrollments: [] };
  await Capture.listCaptureEnrollments('a1');
  expect(last().url).toBe(`${P}/enrollments`);
  await Capture.listCaptureEnrollments('a1', { status: 'pending' });
  expect(last().url).toBe(`${P}/enrollments?status=pending`);
  await Capture.approveCaptureEnrollment('a1', 'e1', 'u9');
  expect(last()).toMatchObject({ method: 'POST', url: `${P}/enrollments/e1/approve`, body: { user_id: 'u9' } });
  await Capture.denyCaptureEnrollment('a1', 'e1');
  expect(last()).toMatchObject({ method: 'POST', url: `${P}/enrollments/e1/deny` });

  const capture = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' }).capture.account('a1');
  expect(Object.keys(capture.enrollment).sort()).toEqual(['approve', 'deny', 'list', 'tokens']);
  expect(Object.keys(capture.enrollment.tokens).sort()).toEqual(['create', 'list', 'revoke']);
  await capture.enrollment.tokens.list();
  expect(last().url).toBe(`${P}/enrollment-tokens`);
  await capture.enrollment.approve('e2', 'u1');
  expect(last()).toMatchObject({ method: 'POST', url: `${P}/enrollments/e2/approve`, body: { user_id: 'u1' } });
});

test('link a device to a Kortix user, or unlink it; approve a waiting computer with or without a member', async () => {
  nextBody = { device_id: 'd1', user_id: 'u1' };
  await Capture.linkCaptureDevice('a1', 'd1', 'u1');
  expect(last()).toMatchObject({ method: 'PUT', url: `${P}/devices/d1/link`, body: { user_id: 'u1' } });
  await Capture.linkCaptureDevice('a1', 'd1', null);
  expect(last()).toMatchObject({ method: 'PUT', url: `${P}/devices/d1/link`, body: { user_id: null } });
  await Capture.approveCaptureEnrollment('a1', 'e1');
  expect(last()).toMatchObject({ method: 'POST', url: `${P}/enrollments/e1/approve`, body: {} });
  const capture = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' }).capture.account('a1');
  await capture.devices.link('d2', 'u2');
  expect(last()).toMatchObject({ method: 'PUT', url: `${P}/devices/d2/link`, body: { user_id: 'u2' } });
});

test('fleet health: the devices answer carries the summary, and a device lands in exactly one bucket', async () => {
  const summary = { recording: 1, idle: 1, attention: 1, not_recording: 1, latest_version: '0.2.0' };
  nextBody = { devices: [], health: summary };
  expect((await listCaptureDevices('a1', { scope: 'account' })).health).toEqual(summary);
  const health = (state: string, idle = false) =>
    ({ health: { state, idle, reasons: [], since: null, latest_version: null } }) as unknown as CaptureDevice;
  expect(captureHealthBucket(health('healthy'))).toBe('recording');
  expect(captureHealthBucket(health('healthy', true))).toBe('idle');
  expect(captureHealthBucket(health('attention'))).toBe('attention');
  expect(captureHealthBucket(health('not_recording'))).toBe('not_recording');
});
