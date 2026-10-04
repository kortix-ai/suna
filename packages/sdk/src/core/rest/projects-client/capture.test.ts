import { beforeEach, expect, mock, test } from 'bun:test';
import { createKortix } from '../../client/kortix';
import { configureKortix } from '../../http/config';
import {
  approveCaptureDeviceGrant,
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
  type CaptureDevice,
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
const P = 'http://test.local/projects/p1/capture';

const POLICY: CapturePolicy = {
  layers: { screen: true, actions: true, audio: false },
  privacy: { redact_pii: true },
  retention: { local_hours: 24, remote_days: 30 },
  recording: { paused: false, paused_until_ms: null },
  notice: 'Recording is on for the support team.',
};

test('devices: list mine, a member, or the project; revoke; set and clear a device override', async () => {
  nextBody = { devices: [{ device_id: 'd1', live: { state: 'recording' } }] };
  const mine = await listCaptureDevices('p1');
  expect(last()).toMatchObject({ method: 'GET', url: `${P}/devices` });
  expect(mine.devices[0]?.live.state).toBe('recording');
  await listCaptureDevices('p1', { userId: 'u2' });
  expect(last().url).toBe(`${P}/devices?user_id=u2`);
  await listCaptureDevices('p1', { scope: 'project' });
  expect(last().url).toBe(`${P}/devices?scope=project`);
  await revokeCaptureDevice('p1', 'd1');
  expect(last()).toMatchObject({ method: 'DELETE', url: `${P}/devices/d1` });
  nextBody = { device_id: 'd1', enqueued: 3, forgotten: 1 };
  const synced = await syncCaptureDevice('p1', 'd1');
  expect([synced.enqueued, synced.forgotten]).toEqual([3, 1]);
  expect(last()).toMatchObject({ method: 'POST', url: `${P}/devices/d1/sync` });
  await setCaptureDevicePolicy('p1', 'd1', POLICY);
  expect(last()).toMatchObject({ method: 'PUT', url: `${P}/devices/d1/policy`, body: { policy: POLICY } });
  await setCaptureDevicePolicy('p1', 'd1', null);
  expect(last().body).toEqual({ policy: null });
});

test('policy: read and write the project policy', async () => {
  nextBody = { policy: POLICY, updated_at: null, updated_by: null };
  expect((await getCapturePolicy('p1')).policy.retention.remote_days).toBe(30);
  expect(last()).toMatchObject({ method: 'GET', url: `${P}/policy` });
  await setCapturePolicy('p1', POLICY);
  expect(last()).toMatchObject({ method: 'PUT', url: `${P}/policy`, body: { policy: POLICY } });
});

test('timeline: a day, a window, and its items; the query names the subject and device', async () => {
  nextBody = { user_id: 'u1', runs: [], chunks: [], ranges: [] };
  await getCaptureTimeline('p1', { day: '2026-10-03' });
  expect(last().url).toBe(`${P}/timeline?day=2026-10-03`);
  await getCaptureTimeline('p1', { from: '2026-10-03T09:00:00.000Z', to: '2026-10-03T10:00:00.000Z', userId: 'u2', deviceId: 'd1' });
  expect(last().url).toBe(`${P}/timeline?from=2026-10-03T09%3A00%3A00.000Z&to=2026-10-03T10%3A00%3A00.000Z&user_id=u2&device_id=d1`);
  await getCaptureTimelineItems('p1', { day: '2026-10-03' });
  expect(last().url).toBe(`${P}/timeline/items?day=2026-10-03`);
});

test('recorded days: grouped in the caller’s time zone, for a member or one device', async () => {
  nextBody = { user_id: 'u1', tz: 'Europe/Berlin', days: [{ day: '2026-10-03', start_at: 'a', end_at: 'b', screen_seconds: 600 }] };
  const result = await getCaptureDays('p1', { tz: 'Europe/Berlin' });
  expect(last()).toMatchObject({ method: 'GET', url: `${P}/days?tz=Europe%2FBerlin` });
  expect(result.days[0]?.screen_seconds).toBe(600);
  await getCaptureDays('p1', { userId: 'u2', deviceId: 'd1' });
  expect(last().url).toBe(`${P}/days?user_id=u2&device_id=d1`);
  await getCaptureDays('p1');
  expect(last().url).toBe(`${P}/days`);
});

test('search: query, kinds, app and limit are sent; hits come back newest first', async () => {
  nextBody = { user_id: 'u1', q: 'invoice', hits: [{ kind: 'screen', id: 'f1', snippet: 'Invoice 1042' }] };
  const result = await searchCapture('p1', { q: 'invoice 1042', kinds: ['screen', 'audio'], app: 'Mail', limit: 5 });
  expect(last().url).toBe(`${P}/search?q=invoice+1042&kinds=screen%2Caudio&app=Mail&limit=5`);
  expect(result.hits[0]?.kind).toBe('screen');
});

test('media: a frame with its video URL, an item’s media, an asset URL', async () => {
  nextBody = { frame: { frame_id: 'f1' }, video: { url: 'https://s3.test/v', offset_ms: 1000, expires_at: 'x', encrypted: false } };
  expect((await getCaptureFrame('p1', 'f1')).video?.offset_ms).toBe(1000);
  expect(last().url).toBe(`${P}/frames/f1`);
  await getCaptureFrame('p1', 'f1', { userId: 'u2' });
  expect(last().url).toBe(`${P}/frames/f1?user_id=u2`);
  await getCaptureChunkMedia('p1', 'c1');
  expect(last().url).toBe(`${P}/chunks/c1/media`);
  await getCaptureAssetUrl('p1', 'd1', `sha256-${'a'.repeat(64)}.png`);
  expect(last().url).toBe(`${P}/devices/d1/assets/sha256-${'a'.repeat(64)}.png`);
});

test('ranges: list, save, read with outputs, process again', async () => {
  nextBody = { ranges: [] };
  await listCaptureRanges('p1', { day: '2026-10-03' });
  expect(last().url).toBe(`${P}/ranges?day=2026-10-03`);
  nextBody = { range_id: 'r1', status: 'closed' };
  await saveCaptureRange('p1', { start_at: '2026-10-03T09:00:00.000Z', end_at: '2026-10-03T09:30:00.000Z', title: 'Budget review' });
  expect(last()).toMatchObject({ method: 'POST', url: `${P}/ranges`, body: { title: 'Budget review' } });
  nextBody = { range_id: 'r1', outputs: [{ kind: 'segmentation', status: 'done' }] };
  expect((await getCaptureRange('p1', 'r1')).outputs[0]?.kind).toBe('segmentation');
  await processCaptureRange('p1', 'r1');
  expect(last()).toMatchObject({ method: 'POST', url: `${P}/ranges/r1/process` });
});

test('people: the managers’ per-member summary', async () => {
  nextBody = { from: 'a', to: 'b', people: [{ user_id: 'u1', active_seconds: 60, apps: [{ app: 'Mail', seconds: 60 }], ranges: 1, devices: 1 }] };
  expect((await getCapturePeople('p1', { day: '2026-10-03' })).people[0]?.active_seconds).toBe(60);
  expect(last().url).toBe(`${P}/people?day=2026-10-03`);
});

test('device sign-in approval: read, approve into a project, deny', async () => {
  nextBody = { user_code: 'ABCD-1234', status: 'pending', device: { name: 'Laptop' } };
  expect((await getCaptureDeviceGrant('abcd-1234')).status).toBe('pending');
  expect(last()).toMatchObject({ method: 'GET', url: 'http://test.local/capture/device/grants/abcd-1234' });
  await approveCaptureDeviceGrant('ABCD-1234', 'p1');
  expect(last()).toMatchObject({ method: 'POST', url: 'http://test.local/capture/device/grants/ABCD-1234/approve', body: { project_id: 'p1' } });
  await denyCaptureDeviceGrant('ABCD-1234');
  expect(last()).toMatchObject({ method: 'POST', url: 'http://test.local/capture/device/grants/ABCD-1234/deny' });
});

test('approval names the computer: { machineId } goes out as machine_id; without it the body has none', async () => {
  const machineId = 'a'.repeat(64);
  await approveCaptureDeviceGrant('ABCD-1234', 'p1', { machineId });
  expect(last()).toMatchObject({ method: 'POST', body: { project_id: 'p1', machine_id: machineId } });
  await approveCaptureDeviceGrant('ABCD-1234', 'p1');
  expect(last().body).toEqual({ project_id: 'p1' });
  // A device row carries the computer it runs on.
  nextBody = { devices: [{ device_id: 'd1', machine_id: machineId }] };
  const devices: CaptureDevice[] = (await listCaptureDevices('p1')).devices;
  expect(devices[0]?.machine_id).toBe(machineId);
});

test('the facade binds capture to a project and exposes the sign-in approval at the top', async () => {
  const kortix = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  nextBody = { hits: [] };
  await kortix.project('p1').capture.search({ q: 'forecast' });
  expect(last().url).toBe(`${P}/search?q=forecast`);
  await kortix.project('p1').capture.devices.list({ scope: 'project' });
  expect(last().url).toBe(`${P}/devices?scope=project`);
  await kortix.project('p1').capture.timeline.get({ day: '2026-10-03' });
  expect(last().url).toBe(`${P}/timeline?day=2026-10-03`);
  await kortix.project('p1').capture.timeline.days({ tz: 'UTC' });
  expect(last().url).toBe(`${P}/days?tz=UTC`);
  await kortix.project('p1').capture.devices.sync('d1');
  expect(last().url).toBe(`${P}/devices/d1/sync`);
  await kortix.project('p1').capture.ranges.process('r1');
  expect(last().url).toBe(`${P}/ranges/r1/process`);
  await kortix.capture.approveDevice('ABCD-1234', 'p1');
  expect(last().url).toBe('http://test.local/capture/device/grants/ABCD-1234/approve');
});
