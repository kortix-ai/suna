import { expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureKortix } from '../core/http/config';
import {
  useApproveCaptureDevice,
  useCaptureChunkMedia,
  useCaptureDays,
  useCaptureDeviceGrant,
  useCaptureDevices,
  useCaptureFrame,
  useCaptureMembers,
  useCapturePeople,
  useCapturePolicy,
  useCaptureRange,
  useCaptureRanges,
  useCaptureSearch,
  useCaptureTimeline,
  useCaptureTimelineItems,
  useCaptureWorkspace,
  useDenyCaptureDevice,
  useProcessCaptureRange,
  useRevokeCaptureDevice,
  useSaveCaptureRange,
  useSetCaptureEnabled,
  useSetCaptureMemberRole,
  useSetCapturePolicy,
  useSyncCaptureDevice,
} from './use-capture';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test('the approval page reads the grant, approves it into an account, and the grant read refreshes', async () => {
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
    await approve!.mutateAsync({ userCode: 'ABCD-1234', accountId: 'a1' });
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
    const path = String(url).replace('http://test.local/accounts/a1/capture', '').split('?')[0]!;
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
    days = useCaptureDays('a1', { tz: 'UTC', userId: 'u2', deviceId: 'd1' });
    timeline = useCaptureTimeline('a1', { from: '2026-10-03T00:00:00.000Z', to: '2026-10-04T00:00:00.000Z', userId: 'u2' });
    useCaptureTimelineItems('a1', { from: '2026-10-03T09:00:00.000Z', to: '2026-10-03T10:00:00.000Z' });
    useCaptureSearch('a1', { q: 'invoice', kinds: ['screen'] });
    useCaptureFrame('a1', 'f1', { userId: 'u2' });
    return null;
  }
  await h.mount(Probe);
  expect(days!.data?.days[0]?.day).toBe('2026-10-03');
  expect(timeline!.data?.runs[0]?.app).toBe('Mail');
  expect(h.calls).toEqual(
    expect.arrayContaining([
      'GET http://test.local/accounts/a1/capture/days?tz=UTC&user_id=u2&device_id=d1',
      'GET http://test.local/accounts/a1/capture/timeline?from=2026-10-03T00%3A00%3A00.000Z&to=2026-10-04T00%3A00%3A00.000Z&user_id=u2',
      'GET http://test.local/accounts/a1/capture/timeline/items?from=2026-10-03T09%3A00%3A00.000Z&to=2026-10-03T10%3A00%3A00.000Z',
      'GET http://test.local/accounts/a1/capture/search?q=invoice&kinds=screen',
      'GET http://test.local/accounts/a1/capture/frames/f1?user_id=u2',
    ]),
  );
});

test('a null account, query or id sends nothing', async () => {
  const h = harness();
  function Probe() {
    useCaptureDays(null);
    useCaptureTimeline('a1', null);
    useCaptureTimelineItems(undefined, { day: '2026-10-03' });
    useCaptureSearch('a1', null);
    useCaptureFrame('a1', null);
    useCaptureRange('a1', null);
    useCaptureRanges('a1', null);
    useCapturePeople('a1', null);
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
    useCaptureRanges('a1', { day: '2026-10-03' });
    useCaptureTimeline('a1', { day: '2026-10-03' });
    useCaptureRange('a1', 'r1');
    save = useSaveCaptureRange('a1');
    reprocess = useProcessCaptureRange('a1');
    return null;
  }
  await h.mount(Probe);
  const count = (prefix: string) => h.calls.filter((c) => c.startsWith(prefix)).length;
  const before = { ranges: count('GET http://test.local/accounts/a1/capture/ranges?'), timeline: count('GET http://test.local/accounts/a1/capture/timeline?'), range: count('GET http://test.local/accounts/a1/capture/ranges/r1') };
  await act(async () => {
    await save!.mutateAsync({ start_at: '2026-10-03T09:00:00.000Z', end_at: '2026-10-03T09:30:00.000Z', title: 'Budget' });
  });
  await h.settle();
  expect(h.calls).toContain('POST http://test.local/accounts/a1/capture/ranges');
  expect(count('GET http://test.local/accounts/a1/capture/ranges?')).toBe(before.ranges + 1);
  expect(count('GET http://test.local/accounts/a1/capture/timeline?')).toBe(before.timeline + 1);
  await act(async () => { await reprocess!.mutateAsync('r1'); });
  await h.settle();
  expect(h.calls).toContain('POST http://test.local/accounts/a1/capture/ranges/r1/process');
  expect(count('GET http://test.local/accounts/a1/capture/ranges/r1')).toBeGreaterThan(before.range);
});

test('devices: the account list for admins; revoke and sync refresh it', async () => {
  const h = harness();
  h.bodies['GET /devices'] = { devices: [{ device_id: 'd1', live: { state: 'recording' } }] };
  h.bodies['POST /devices/d1/sync'] = { device_id: 'd1', enqueued: 2 };
  let devices: ReturnType<typeof useCaptureDevices>;
  let revoke: ReturnType<typeof useRevokeCaptureDevice>;
  let sync: ReturnType<typeof useSyncCaptureDevice>;
  function Probe() {
    devices = useCaptureDevices('a1', { scope: 'account' });
    revoke = useRevokeCaptureDevice('a1');
    sync = useSyncCaptureDevice('a1');
    return null;
  }
  await h.mount(Probe);
  expect(devices!.data?.devices[0]?.live.state).toBe('recording');
  const lists = () => h.calls.filter((c) => c === 'GET http://test.local/accounts/a1/capture/devices?scope=account').length;
  const before = lists();
  await act(async () => { expect((await sync!.mutateAsync('d1')).enqueued).toBe(2); });
  await h.settle();
  await act(async () => { await revoke!.mutateAsync('d1'); });
  await h.settle();
  expect(h.calls).toContain('DELETE http://test.local/accounts/a1/capture/devices/d1');
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
    read = useCapturePolicy('a1');
    write = useSetCapturePolicy('a1');
    people = useCapturePeople('a1', { from: '2026-09-27T00:00:00.000Z', to: '2026-10-04T00:00:00.000Z' });
    return null;
  }
  await h.mount(Probe);
  expect(read!.data?.policy.notice).toBe('On');
  expect(people!.data?.people[0]?.active_seconds).toBe(60);
  await act(async () => { await write!.mutateAsync({ ...policy, notice: 'Changed' }); });
  await h.settle();
  expect(read!.data?.policy.notice).toBe('Changed');
  expect(h.calls.filter((c) => c === 'GET http://test.local/accounts/a1/capture/policy').length).toBe(1);
});

test('chunk media: one signed URL read per chunk, for a member too; a null chunk sends nothing', async () => {
  const h = harness();
  h.bodies['GET /chunks/c1/media'] = { chunk_id: 'c1', kind: 'chunk', video: { url: 'https://s3.test/v', expires_at: 'x', encrypted: false }, audio: null };
  let media: ReturnType<typeof useCaptureChunkMedia>;
  function Probe() {
    media = useCaptureChunkMedia('a1', 'c1', { userId: 'u2' });
    useCaptureChunkMedia('a1', null);
    return null;
  }
  await h.mount(Probe);
  expect(media!.data?.video?.url).toBe('https://s3.test/v');
  expect(h.calls).toEqual(['GET http://test.local/accounts/a1/capture/chunks/c1/media?user_id=u2']);
});

test('workspace: turning Capture on writes the switch and refreshes the account; a role change refreshes the members', async () => {
  const h = harness();
  h.bodies['GET '] = { account_id: 'a1', enabled: false, role: 'admin', can_manage: true, updated_at: null };
  h.bodies['PATCH '] = { account_id: 'a1', enabled: true, role: 'admin', can_manage: true, updated_at: 'now' };
  h.bodies['GET /members'] = { members: [{ user_id: 'u2', account_role: 'member', role: 'member', overridden: false }] };
  let workspace: ReturnType<typeof useCaptureWorkspace>;
  let setEnabled: ReturnType<typeof useSetCaptureEnabled>;
  let members: ReturnType<typeof useCaptureMembers>;
  let setRole: ReturnType<typeof useSetCaptureMemberRole>;
  function Probe() {
    workspace = useCaptureWorkspace('a1');
    setEnabled = useSetCaptureEnabled('a1');
    members = useCaptureMembers('a1');
    setRole = useSetCaptureMemberRole('a1');
    return null;
  }
  await h.mount(Probe);
  expect(workspace!.data?.enabled).toBe(false);
  expect(members!.data?.members[0]?.role).toBe('member');
  // The server now answers the new state, as after a real write.
  h.bodies['GET '] = h.bodies['PATCH '];
  await act(async () => { await setEnabled!.mutateAsync(true); });
  await h.settle();
  expect(h.calls).toContain('PATCH http://test.local/accounts/a1/capture');
  expect(workspace!.data?.enabled).toBe(true);
  const lists = () => h.calls.filter((c) => c === 'GET http://test.local/accounts/a1/capture/members').length;
  const before = lists();
  await act(async () => { await setRole!.mutateAsync({ userId: 'u2', role: 'viewer' }); });
  await h.settle();
  expect(h.calls).toContain('PUT http://test.local/accounts/a1/capture/members/u2');
  expect(lists()).toBeGreaterThan(before);
});

test('a null account reads no workspace and no members', async () => {
  const h = harness();
  function Probe() {
    useCaptureWorkspace(null);
    useCaptureMembers(undefined);
    return null;
  }
  await h.mount(Probe);
  expect(h.calls).toEqual([]);
});
