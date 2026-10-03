import { expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureKortix } from '../core/http/config';
import {
  useApproveCaptureDevice,
  useCaptureDays,
  useCaptureDeviceGrant,
  useCaptureDevices,
  useCaptureFrame,
  useCapturePeople,
  useCapturePolicy,
  useCaptureRange,
  useCaptureRanges,
  useCaptureSearch,
  useCaptureTimeline,
  useCaptureTimelineItems,
  useDenyCaptureDevice,
  useProcessCaptureRange,
  useRevokeCaptureDevice,
  useSaveCaptureRange,
  useSetCapturePolicy,
  useSyncCaptureDevice,
} from './use-capture';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test('the approval page reads the grant, approves it into a project, and the grant read refreshes', async () => {
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const calls: string[] = [];
  let status = 'pending';
  globalThis.fetch = mock(async (url: unknown, options: RequestInit = {}) => {
    calls.push(`${options.method ?? 'GET'} ${String(url)}`);
    if (options.method === 'POST' && String(url).endsWith('/approve')) status = 'approved';
    return Response.json({ user_code: 'ABCD-1234', status, device: { name: 'Laptop' } });
  }) as unknown as typeof fetch;
  let grant: ReturnType<typeof useCaptureDeviceGrant>;
  let approve: ReturnType<typeof useApproveCaptureDevice>;
  let deny: ReturnType<typeof useDenyCaptureDevice>;
  function Probe() {
    grant = useCaptureDeviceGrant('ABCD-1234');
    approve = useApproveCaptureDevice();
    deny = useDenyCaptureDevice();
    return null;
  }
  await act(async () => {
    create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(grant!.data?.status).toBe('pending');
  await act(async () => {
    await approve!.mutateAsync({ userCode: 'ABCD-1234', projectId: 'p1' });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(calls).toContain('POST http://test.local/capture/device/grants/ABCD-1234/approve');
  expect(grant!.data?.status).toBe('approved');
  await act(async () => {
    await deny!.mutateAsync('ABCD-1234');
  });
  expect(calls).toContain('POST http://test.local/capture/device/grants/ABCD-1234/deny');
});

test('no user code, no request', async () => {
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const fetchMock = mock(async () => Response.json({}));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  function Probe() {
    useCaptureDeviceGrant(null);
    return null;
  }
  await act(async () => {
    create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(fetchMock.mock.calls.length).toBe(0);
});

function harness() {
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const calls: string[] = [];
  const bodies: Record<string, unknown> = {};
  globalThis.fetch = mock(async (url: unknown, options: RequestInit = {}) => {
    const call = `${options.method ?? 'GET'} ${String(url)}`;
    calls.push(call);
    const path = String(url).replace('http://test.local/projects/p1/capture', '').split('?')[0]!;
    return Response.json(bodies[`${options.method ?? 'GET'} ${path}`] ?? {});
  }) as unknown as typeof fetch;
  const mount = async (Probe: () => null) => {
    await act(async () => {
      create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  };
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  return { client, calls, bodies, mount, settle };
}

test('the timeline page reads days, the timeline, items, a search and a frame for one member and device', async () => {
  const h = harness();
  h.bodies['GET /days'] = { days: [{ day: '2026-10-03', start_at: 'a', end_at: 'b', screen_seconds: 60 }] };
  h.bodies['GET /timeline'] = { runs: [{ app: 'Mail' }], chunks: [], ranges: [] };
  let days: ReturnType<typeof useCaptureDays>;
  let timeline: ReturnType<typeof useCaptureTimeline>;
  function Probe() {
    days = useCaptureDays('p1', { tz: 'UTC', userId: 'u2', deviceId: 'd1' });
    timeline = useCaptureTimeline('p1', { from: '2026-10-03T00:00:00.000Z', to: '2026-10-04T00:00:00.000Z', userId: 'u2' });
    useCaptureTimelineItems('p1', { from: '2026-10-03T09:00:00.000Z', to: '2026-10-03T10:00:00.000Z' });
    useCaptureSearch('p1', { q: 'invoice', kinds: ['screen'] });
    useCaptureFrame('p1', 'f1', { userId: 'u2' });
    return null;
  }
  await h.mount(Probe);
  expect(days!.data?.days[0]?.day).toBe('2026-10-03');
  expect(timeline!.data?.runs[0]?.app).toBe('Mail');
  expect(h.calls).toEqual(
    expect.arrayContaining([
      'GET http://test.local/projects/p1/capture/days?tz=UTC&user_id=u2&device_id=d1',
      'GET http://test.local/projects/p1/capture/timeline?from=2026-10-03T00%3A00%3A00.000Z&to=2026-10-04T00%3A00%3A00.000Z&user_id=u2',
      'GET http://test.local/projects/p1/capture/timeline/items?from=2026-10-03T09%3A00%3A00.000Z&to=2026-10-03T10%3A00%3A00.000Z',
      'GET http://test.local/projects/p1/capture/search?q=invoice&kinds=screen',
      'GET http://test.local/projects/p1/capture/frames/f1?user_id=u2',
    ]),
  );
});

test('a null project, query or id sends nothing', async () => {
  const h = harness();
  function Probe() {
    useCaptureDays(null);
    useCaptureTimeline('p1', null);
    useCaptureTimelineItems(undefined, { day: '2026-10-03' });
    useCaptureSearch('p1', null);
    useCaptureFrame('p1', null);
    useCaptureRange('p1', null);
    useCaptureRanges('p1', null);
    useCapturePeople('p1', null);
    useCaptureDevices(null);
    useCapturePolicy(null);
    return null;
  }
  await h.mount(Probe);
  expect(h.calls).toEqual([]);
});

test('saving a range refreshes the ranges and the timeline; reprocessing refreshes the range', async () => {
  const h = harness();
  h.bodies['GET /ranges'] = { ranges: [] };
  h.bodies['POST /ranges'] = { range_id: 'r1', status: 'closed' };
  h.bodies['GET /ranges/r1'] = { range_id: 'r1', status: 'processed', outputs: [] };
  let save: ReturnType<typeof useSaveCaptureRange>;
  let reprocess: ReturnType<typeof useProcessCaptureRange>;
  function Probe() {
    useCaptureRanges('p1', { day: '2026-10-03' });
    useCaptureTimeline('p1', { day: '2026-10-03' });
    useCaptureRange('p1', 'r1');
    save = useSaveCaptureRange('p1');
    reprocess = useProcessCaptureRange('p1');
    return null;
  }
  await h.mount(Probe);
  const count = (prefix: string) => h.calls.filter((c) => c.startsWith(prefix)).length;
  const before = { ranges: count('GET http://test.local/projects/p1/capture/ranges?'), timeline: count('GET http://test.local/projects/p1/capture/timeline?'), range: count('GET http://test.local/projects/p1/capture/ranges/r1') };
  await act(async () => {
    await save!.mutateAsync({ start_at: '2026-10-03T09:00:00.000Z', end_at: '2026-10-03T09:30:00.000Z', title: 'Budget' });
  });
  await h.settle();
  expect(h.calls).toContain('POST http://test.local/projects/p1/capture/ranges');
  expect(count('GET http://test.local/projects/p1/capture/ranges?')).toBe(before.ranges + 1);
  expect(count('GET http://test.local/projects/p1/capture/timeline?')).toBe(before.timeline + 1);
  await act(async () => { await reprocess!.mutateAsync('r1'); });
  await h.settle();
  expect(h.calls).toContain('POST http://test.local/projects/p1/capture/ranges/r1/process');
  expect(count('GET http://test.local/projects/p1/capture/ranges/r1')).toBeGreaterThan(before.range);
});

test('devices: the project list for managers; revoke and sync refresh it', async () => {
  const h = harness();
  h.bodies['GET /devices'] = { devices: [{ device_id: 'd1', live: { state: 'recording' } }] };
  h.bodies['POST /devices/d1/sync'] = { device_id: 'd1', enqueued: 2 };
  let devices: ReturnType<typeof useCaptureDevices>;
  let revoke: ReturnType<typeof useRevokeCaptureDevice>;
  let sync: ReturnType<typeof useSyncCaptureDevice>;
  function Probe() {
    devices = useCaptureDevices('p1', { scope: 'project' });
    revoke = useRevokeCaptureDevice('p1');
    sync = useSyncCaptureDevice('p1');
    return null;
  }
  await h.mount(Probe);
  expect(devices!.data?.devices[0]?.live.state).toBe('recording');
  const lists = () => h.calls.filter((c) => c === 'GET http://test.local/projects/p1/capture/devices?scope=project').length;
  const before = lists();
  await act(async () => { expect((await sync!.mutateAsync('d1')).enqueued).toBe(2); });
  await h.settle();
  await act(async () => { await revoke!.mutateAsync('d1'); });
  await h.settle();
  expect(h.calls).toContain('DELETE http://test.local/projects/p1/capture/devices/d1');
  expect(lists()).toBe(before + 2);
});

test('policy: read, then a write replaces the cached record without a refetch; people for managers', async () => {
  const h = harness();
  const policy = { layers: { screen: true, actions: true, audio: false }, privacy: { redact_pii: true }, retention: { local_hours: 24, remote_days: 30 }, recording: { paused: false, paused_until_ms: null }, notice: 'On' };
  h.bodies['GET /policy'] = { policy, updated_at: null, updated_by: null };
  h.bodies['PUT /policy'] = { policy: { ...policy, notice: 'Changed' }, updated_at: 'now', updated_by: 'u1' };
  h.bodies['GET /people'] = { people: [{ user_id: 'u1', active_seconds: 60 }] };
  let read: ReturnType<typeof useCapturePolicy>;
  let write: ReturnType<typeof useSetCapturePolicy>;
  let people: ReturnType<typeof useCapturePeople>;
  function Probe() {
    read = useCapturePolicy('p1');
    write = useSetCapturePolicy('p1');
    people = useCapturePeople('p1', { from: '2026-09-27T00:00:00.000Z', to: '2026-10-04T00:00:00.000Z' });
    return null;
  }
  await h.mount(Probe);
  expect(read!.data?.policy.notice).toBe('On');
  expect(people!.data?.people[0]?.active_seconds).toBe(60);
  await act(async () => { await write!.mutateAsync({ ...policy, notice: 'Changed' }); });
  await h.settle();
  expect(read!.data?.policy.notice).toBe('Changed');
  expect(h.calls.filter((c) => c === 'GET http://test.local/projects/p1/capture/policy').length).toBe(1);
});
