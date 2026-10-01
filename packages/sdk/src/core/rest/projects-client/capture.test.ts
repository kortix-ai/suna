// Kortix Capture user API — wire contract pinned here:
//   GET/PUT /accounts/:id/capture/settings
//   GET     /capture/devices          PUT /capture/devices/:deviceId
//   GET     /accounts/:id/capture/{search,timeline}
//   GET     /accounts/:id/capture/chunks/:chunkId/video
//   GET     /accounts/:id/capture/frames/:frameId
//   DELETE  /accounts/:id/capture/data
import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  deleteCaptureData,
  getCaptureFrame,
  getCaptureSettings,
  getCaptureVideoUrl,
  listCaptureDevices,
  searchCapture,
  getCaptureTimeline,
  getProjectCaptureFrame,
  getProjectCaptureTimeline,
  searchProjectCapture,
  updateCaptureDevice,
  updateCaptureSettings,
} from './capture';

let calls: Array<{ url: string; method: string; body: unknown }> = [];
let nextBody: unknown = {};

beforeEach(() => {
  calls = [];
  nextBody = {};
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: unknown } = {}) => {
    calls.push({ url: String(url), method: opts.method ?? 'GET', body: opts.body });
    return new Response(JSON.stringify(nextBody), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1]!;

test('settings: GET, and PUT sends only the fields given', async () => {
  nextBody = { enabled: true, admins_can_view: false, retention_days: 30, updated_at: null };
  expect((await getCaptureSettings('acc-1')).enabled).toBe(true);
  expect(last()).toMatchObject({ url: 'http://test.local/accounts/acc-1/capture/settings', method: 'GET' });
  await updateCaptureSettings('acc-1', { admins_can_view: true });
  expect(last().method).toBe('PUT');
  expect(JSON.parse(last().body as string)).toEqual({ admins_can_view: true });
});

test('devices: list and update (enabled, paused_until, account_id)', async () => {
  nextBody = { devices: [] };
  expect((await listCaptureDevices()).devices).toEqual([]);
  expect(last().url).toBe('http://test.local/capture/devices');
  await updateCaptureDevice('dev-1', { enabled: true, paused_until: null, account_id: 'acc-1' });
  expect(last()).toMatchObject({ url: 'http://test.local/capture/devices/dev-1', method: 'PUT' });
  expect(JSON.parse(last().body as string)).toEqual({ enabled: true, paused_until: null, account_id: 'acc-1' });
});

test('search and timeline put the filters in the query and drop unset ones', async () => {
  nextBody = { items: [], next_cursor: null };
  await searchCapture('acc-1', { q: 'two words', domain: 'example.com', limit: 5, user_id: undefined });
  const url = new URL(last().url);
  expect(url.pathname).toBe('/accounts/acc-1/capture/search');
  expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'two words', domain: 'example.com', limit: '5' });
  nextBody = { chunks: [], apps: [] };
  await getCaptureTimeline('acc-1', { from: '2026-10-01T00:00:00Z' });
  expect(last().url).toBe('http://test.local/accounts/acc-1/capture/timeline?from=2026-10-01T00%3A00%3A00Z');
});

test('video url, frame detail and delete data', async () => {
  nextBody = { url: 'http://s/x', expires_at: '2026-10-01T00:10:00Z' };
  expect((await getCaptureVideoUrl('acc-1', 'ch-1')).url).toBe('http://s/x');
  expect(last().url).toBe('http://test.local/accounts/acc-1/capture/chunks/ch-1/video');
  nextBody = { frame_id: 7, text: 't' };
  await getCaptureFrame('acc-1', 7);
  expect(last().url).toBe('http://test.local/accounts/acc-1/capture/frames/7');
  nextBody = { deleted_chunks: 2 };
  expect((await deleteCaptureData('acc-1', { to: '2026-10-02T00:00:00Z' })).deleted_chunks).toBe(2);
  expect(last()).toMatchObject({
    url: 'http://test.local/accounts/acc-1/capture/data?to=2026-10-02T00%3A00%3A00Z',
    method: 'DELETE',
  });
});

test('project routes (agents, CLI in a sandbox): search, timeline, frame for the acting person', async () => {
  nextBody = { items: [], next_cursor: null };
  await searchProjectCapture('proj-1', { q: 'invoice', app: 'Notes', limit: 5 });
  expect(last()).toMatchObject({ url: 'http://test.local/projects/proj-1/capture/search?q=invoice&app=Notes&limit=5', method: 'GET' });
  nextBody = { chunks: [], apps: [] };
  await getProjectCaptureTimeline('proj-1', { from: '2026-10-01T00:00:00Z' });
  expect(last().url).toBe('http://test.local/projects/proj-1/capture/timeline?from=2026-10-01T00%3A00%3A00Z');
  nextBody = { frame_id: 7 };
  await getProjectCaptureFrame('proj-1', 7);
  expect(last().url).toBe('http://test.local/projects/proj-1/capture/frames/7');
});
