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
  useCapturePolicy,
  useCaptureSearch,
  useCaptureTimeline,
  useCaptureTimelineItems,
  useCaptureWorkspace,
  useDenyCaptureDevice,
  useRevokeCaptureDevice,
  useSetCaptureEnabled,
  useSetCapturePolicy,
  useCaptureStorage,
  useSetCaptureStorage,
} from './use-capture';
import * as hooks from './use-capture';

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

test('the timeline page reads days, the timeline, items and a search for one member and device', async () => {
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
    useCaptureDevices(null);
    useCapturePolicy(null);
    return null;
  }
  await h.mount(Probe);
  expect(h.calls).toEqual([]);
});

test('raw capture only: no range, people, Capture-role or device-sync hooks', () => {
  for (const name of [
    'useCaptureRanges',
    'useCaptureRange',
    'useSaveCaptureRange',
    'useProcessCaptureRange',
    'useCapturePeople',
    'useCaptureMembers',
    'useSetCaptureMemberRole',
    'useSyncCaptureDevice',
    // No host reads a single frame through a hook; `kortix.capture.account(id).frame()` stays.
    'useCaptureFrame',
  ]) {
    expect(name in hooks).toBe(false);
  }
});

test('devices: the account list (capture.read_all); a revoke refreshes it', async () => {
  const h = harness();
  h.bodies['GET /devices'] = { devices: [{ device_id: 'd1', live: { state: 'recording' } }] };
  let devices: ReturnType<typeof useCaptureDevices>;
  let revoke: ReturnType<typeof useRevokeCaptureDevice>;
  function Probe() {
    devices = useCaptureDevices('a1', { scope: 'account' });
    revoke = useRevokeCaptureDevice('a1');
    return null;
  }
  await h.mount(Probe);
  expect(devices!.data?.devices[0]?.live.state).toBe('recording');
  const lists = () => h.calls.filter((c) => c === 'GET http://test.local/accounts/a1/capture/devices?scope=account').length;
  const before = lists();
  await act(async () => { await revoke!.mutateAsync('d1'); });
  await h.settle();
  expect(h.calls).toContain('DELETE http://test.local/accounts/a1/capture/devices/d1');
  expect(lists()).toBe(before + 1);
});

test('policy: read, then a write replaces the cached record without a refetch', async () => {
  const h = harness();
  const policy = { layers: { screen: true, actions: true, audio: false }, privacy: { redact_pii: true, excluded_bundle_ids: [], excluded_domains: [], exclusion_groups: ['password_managers' as const], exclude_private_browsing: true }, retention: { local_hours: 24, remote_days: 30 }, recording: { paused: false, paused_until_ms: null }, notice: 'On' };
  h.bodies['GET /policy'] = { policy, updated_at: null, updated_by: null };
  h.bodies['PUT /policy'] = { policy: { ...policy, notice: 'Changed' }, updated_at: 'now', updated_by: 'u1' };
  let read: ReturnType<typeof useCapturePolicy>;
  let write: ReturnType<typeof useSetCapturePolicy>;
  function Probe() {
    read = useCapturePolicy('a1');
    write = useSetCapturePolicy('a1');
    return null;
  }
  await h.mount(Probe);
  expect(read!.data?.policy.notice).toBe('On');
  await act(async () => { await write!.mutateAsync({ ...policy, notice: 'Changed' }); });
  await h.settle();
  expect(read!.data?.policy.notice).toBe('Changed');
  expect(h.calls.filter((c) => c === 'GET http://test.local/accounts/a1/capture/policy').length).toBe(1);
});

test('storage: read the destination, then a write replaces the cached view without a refetch', async () => {
  const h = harness();
  h.bodies['GET /storage'] = { mode: 'kortix' };
  h.bodies['PUT /storage'] = {
    mode: 's3', endpoint: 'https://s3.example.com', region: 'us-east-1', bucket: 'my-bucket',
    force_path_style: true, role_arn: '', access_key_id: 'AKIAEXAMPLE', has_secret: true, per_device_scoped: false,
  };
  let read: ReturnType<typeof useCaptureStorage>;
  let write: ReturnType<typeof useSetCaptureStorage>;
  function Probe() {
    read = useCaptureStorage('a1');
    write = useSetCaptureStorage('a1');
    return null;
  }
  await h.mount(Probe);
  expect(read!.data?.mode).toBe('kortix');
  await act(async () => {
    await write!.mutateAsync({ mode: 's3', region: 'us-east-1', bucket: 'my-bucket', force_path_style: true, access_key_id: 'AKIAEXAMPLE', secret_access_key: 'synthetic-secret' });
  });
  await h.settle();
  expect(read!.data?.mode).toBe('s3');
  expect(read!.data).toMatchObject({ bucket: 'my-bucket', has_secret: true, per_device_scoped: false });
  expect(h.calls.filter((c) => c === 'GET http://test.local/accounts/a1/capture/storage').length).toBe(1);
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

test('workspace: turning Capture on writes the switch and refreshes the account', async () => {
  const h = harness();
  h.bodies['GET '] = { account_id: 'a1', enabled: false, can_read_all: true, can_manage: true, updated_at: null };
  h.bodies['PATCH '] = { account_id: 'a1', enabled: true, can_read_all: true, can_manage: true, updated_at: 'now' };
  let workspace: ReturnType<typeof useCaptureWorkspace>;
  let setEnabled: ReturnType<typeof useSetCaptureEnabled>;
  function Probe() {
    workspace = useCaptureWorkspace('a1');
    setEnabled = useSetCaptureEnabled('a1');
    return null;
  }
  await h.mount(Probe);
  expect(workspace!.data?.enabled).toBe(false);
  expect(workspace!.data?.can_read_all).toBe(true);
  // The server now answers the new state, as after a real write.
  h.bodies['GET '] = h.bodies['PATCH '];
  await act(async () => { await setEnabled!.mutateAsync(true); });
  await h.settle();
  expect(h.calls).toContain('PATCH http://test.local/accounts/a1/capture');
  expect(workspace!.data?.enabled).toBe(true);
});

test('a null account reads no workspace', async () => {
  const h = harness();
  function Probe() {
    useCaptureWorkspace(null);
    useCaptureWorkspace(undefined);
    return null;
  }
  await h.mount(Probe);
  expect(h.calls).toEqual([]);
});

test('the Devices page: tokens and waiting computers refresh after create, revoke, approve and deny', async () => {
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const calls: string[] = [];
  let tokens: unknown[] = [];
  let enrollments: unknown[] = [{ enrollment_id: 'e1', status: 'pending' }];
  globalThis.fetch = mock(async (url: unknown, options: RequestInit = {}) => {
    const method = options.method ?? 'GET';
    const path = String(url).replace('http://test.local/accounts/a1/capture', '');
    calls.push(`${method} ${path}`);
    if (method === 'POST' && path === '/enrollment-tokens') {
      tokens = [{ token_id: 't1', state: 'active' }];
      return Response.json({ token_id: 't1', state: 'active', token: 'kortix_enr_secret' }, { status: 201 });
    }
    if (method === 'DELETE') tokens = [{ token_id: 't1', state: 'revoked' }];
    if (method === 'POST' && path.endsWith('/approve')) enrollments = [{ enrollment_id: 'e1', status: 'approved' }];
    if (method === 'POST' && path.endsWith('/deny')) enrollments = [{ enrollment_id: 'e1', status: 'denied' }];
    if (path === '/enrollment-tokens') return Response.json({ tokens });
    if (path.startsWith('/enrollments?') || path === '/enrollments') return Response.json({ enrollments });
    return Response.json({});
  }) as unknown as typeof fetch;
  let list: ReturnType<typeof hooks.useCaptureEnrollmentTokens>;
  let create_: ReturnType<typeof hooks.useCreateCaptureEnrollmentToken>;
  let revoke: ReturnType<typeof hooks.useRevokeCaptureEnrollmentToken>;
  let waiting: ReturnType<typeof hooks.useCaptureEnrollments>;
  let approve: ReturnType<typeof hooks.useApproveCaptureEnrollment>;
  let deny: ReturnType<typeof hooks.useDenyCaptureEnrollment>;
  function Probe() {
    list = hooks.useCaptureEnrollmentTokens('a1');
    create_ = hooks.useCreateCaptureEnrollmentToken('a1');
    revoke = hooks.useRevokeCaptureEnrollmentToken('a1');
    waiting = hooks.useCaptureEnrollments('a1');
    approve = hooks.useApproveCaptureEnrollment('a1');
    deny = hooks.useDenyCaptureEnrollment('a1');
    return null;
  }
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  await act(async () => {
    create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
  });
  await settle();
  expect(list!.data?.tokens.map((token) => token.state)).toEqual([]);
  expect(waiting!.data?.enrollments.map((row) => row.status)).toEqual(['pending']);

  let secret = '';
  await act(async () => {
    secret = (await create_!.mutateAsync({ name: 'Pilot laptops', max_devices: 20 })).token;
  });
  await settle();
  expect(secret).toBe('kortix_enr_secret');
  expect(list!.data?.tokens.map((token) => token.state)).toEqual(['active']);

  await act(async () => { await revoke!.mutateAsync('t1'); });
  await settle();
  expect(calls).toContain('DELETE /enrollment-tokens/t1');
  expect(list!.data?.tokens.map((token) => token.state)).toEqual(['revoked']);

  await act(async () => { await approve!.mutateAsync({ enrollmentId: 'e1', userId: 'u1' }); });
  await settle();
  expect(calls).toContain('POST /enrollments/e1/approve');
  expect(waiting!.data?.enrollments.map((row) => row.status)).toEqual(['approved']);

  await act(async () => { await deny!.mutateAsync('e1'); });
  await settle();
  expect(calls).toContain('POST /enrollments/e1/deny');
  expect(waiting!.data?.enrollments.map((row) => row.status)).toEqual(['denied']);
});

test('linking a device refreshes the device lists', async () => {
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let linkedTo: string | null = null;
  const calls: string[] = [];
  globalThis.fetch = mock(async (url: unknown, options: RequestInit = {}) => {
    const method = options.method ?? 'GET';
    const path = String(url).replace('http://test.local/accounts/a1/capture', '');
    calls.push(`${method} ${path}`);
    if (method === 'PUT') linkedTo = JSON.parse(String(options.body)).user_id;
    if (path.startsWith('/devices')) return Response.json({ devices: [{ device_id: 'd1', user_id: linkedTo }] });
    return Response.json({ device_id: 'd1', user_id: linkedTo });
  }) as unknown as typeof fetch;
  let devices: ReturnType<typeof hooks.useCaptureDevices>;
  let link: ReturnType<typeof hooks.useLinkCaptureDevice>;
  function Probe() {
    devices = hooks.useCaptureDevices('a1', { scope: 'account' });
    link = hooks.useLinkCaptureDevice('a1');
    return null;
  }
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  await act(async () => { create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe))); });
  await settle();
  expect(devices!.data?.devices[0]?.user_id).toBeNull();
  await act(async () => { await link!.mutateAsync({ deviceId: 'd1', userId: 'u1' }); });
  await settle();
  expect(calls).toContain('PUT /devices/d1/link');
  expect(devices!.data?.devices[0]?.user_id).toBe('u1');
});
