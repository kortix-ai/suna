import { beforeEach, expect, mock, test } from 'bun:test';
import { ApiError } from '../core/http/api/errors';
import type { TunnelConnection } from './use-tunnel';

// A paired computer is an account of the project's `computer` connector. The
// API deleted per-machine permission editing, permission requests, the tunnel
// audit log, and `POST /tunnel/connections` (pairing is device-auth only).
// Those hooks stay exported until the next major but fail at once with
// ENDPOINT_RETIRED and send no request. Same harness as
// `./retired-admin-hooks.test.ts`: react-query is reduced to identity
// functions so a hook returns its config.

let requests: Array<{ method: string; path: string; body?: unknown }> = [];
let invalidated: unknown[][] = [];
let getOverride: { success: boolean; error?: Error; data?: unknown } | null = null;

mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
  useMutation: (config: Record<string, unknown>) => config,
  useQueryClient: () => ({
    invalidateQueries: ({ queryKey }: { queryKey: unknown[] }) => {
      invalidated.push(queryKey);
    },
  }),
}));

const record = (method: string) => async (path: string, body?: unknown) => {
  requests.push({ method, path, body });
  if (method === 'GET' && getOverride) return getOverride;
  return { data: { success: true, tunnelId: 'tunnel-1', connectionId: 'connection-1' }, error: null, success: true };
};
const actualApiClient = await import('../core/http/api-client');
mock.module('../core/http/api-client', () => ({
  ...actualApiClient,
  backendApi: {
    get: record('GET'),
    post: record('POST'),
    put: record('PUT'),
    patch: record('PATCH'),
    delete: record('DELETE'),
  },
}));

const tunnel = await import('./use-tunnel');

beforeEach(() => {
  requests = [];
  invalidated = [];
  getOverride = null;
});

type Config = {
  queryFn?: () => Promise<unknown>;
  mutationFn?: (vars: unknown) => Promise<unknown>;
  onSuccess?: (data: unknown, vars: unknown) => void;
  retry?: unknown;
  refetchInterval?: unknown;
};

const RETIRED_HOOKS: Array<[name: string, hook: () => unknown]> = [
  ['useCreateTunnelConnection', () => tunnel.useCreateTunnelConnection()],
  ['useTunnelPermissions', () => tunnel.useTunnelPermissions('tunnel-1')],
  ['useGrantTunnelPermission', () => tunnel.useGrantTunnelPermission()],
  ['useRevokeTunnelPermission', () => tunnel.useRevokeTunnelPermission()],
  ['useTunnelPermissionRequests', () => tunnel.useTunnelPermissionRequests()],
  ['useApprovePermissionRequest', () => tunnel.useApprovePermissionRequest()],
  ['useDenyPermissionRequest', () => tunnel.useDenyPermissionRequest()],
  ['useTunnelAuditLogs', () => tunnel.useTunnelAuditLogs('tunnel-1')],
];

test.each(RETIRED_HOOKS)('%s fails with ENDPOINT_RETIRED and sends no request', async (name, hook) => {
  const config = hook() as Config;
  const run = config.queryFn ? config.queryFn() : config.mutationFn!({});
  const error = await run.then(
    () => null,
    (e: unknown) => e,
  );

  expect((error as { code?: string } | null)?.code).toBe('ENDPOINT_RETIRED');
  expect((error as Error).message).toContain(name);
  expect(requests).toEqual([]);
  if (config.queryFn) {
    expect(config.retry).toBe(false);
    expect(config.refetchInterval).toBeUndefined();
  }
});

test('useTunnelConnections rethrows the API error with its status intact', async () => {
  // The web QueryClient's default retry guard reads `error.status` and stops
  // on 4xx. A re-thrown status-less `new Error(message)` defeats it: with a
  // dead token the 5 s poller then ran two full default-retry cycles
  // (1/2/4 s) of 401s on `GET /tunnel/connections` — 8 warn lines.
  getOverride = { success: false, error: new ApiError('Invalid or expired token', { status: 401 }) };
  const config = tunnel.useTunnelConnections() as unknown as Config;
  const error = await config.queryFn!().then(() => null, (e: unknown) => e);
  expect((error as { status?: number }).status).toBe(401);
});

test('useTunnelConnection rethrows the API error with its status intact', async () => {
  getOverride = { success: false, error: new ApiError('Invalid or expired token', { status: 401 }) };
  const config = tunnel.useTunnelConnection('tunnel-1') as unknown as Config;
  const error = await config.queryFn!().then(() => null, (e: unknown) => e);
  expect((error as { status?: number }).status).toBe(401);
});

test('useDeviceAuthInfo rethrows the API error with its status intact', async () => {
  getOverride = { success: false, error: new ApiError('Invalid or expired token', { status: 401 }) };
  const config = tunnel.useDeviceAuthInfo('ABCD-1234') as unknown as Config;
  const error = await config.queryFn!().then(() => null, (e: unknown) => e);
  expect((error as { status?: number }).status).toBe(401);
});

test('useApproveDeviceAuth sends project_id and share on the wire', async () => {
  const config = tunnel.useApproveDeviceAuth() as unknown as Config;
  await config.mutationFn!({
    code: 'ABCD-1234',
    name: 'Studio Mac',
    capabilities: ['filesystem', 'shell'],
    projectId: 'project-1',
    share: 'project',
  });
  expect(requests).toEqual([
    {
      method: 'POST',
      path: '/tunnel/device-auth/ABCD-1234/approve',
      body: {
        name: 'Studio Mac',
        capabilities: ['filesystem', 'shell'],
        project_id: 'project-1',
        share: 'project',
      },
    },
  ]);
});

test('useApproveDeviceAuth returns the computer account the approval created', async () => {
  type ApproveResult = Awaited<ReturnType<ReturnType<typeof tunnel.useApproveDeviceAuth>['mutateAsync']>>;
  const config = tunnel.useApproveDeviceAuth() as unknown as Config;
  const result = (await config.mutationFn!({ code: 'ABCD-1234', projectId: 'project-1' })) as ApproveResult;
  expect(result.tunnelId).toBe('tunnel-1');
  expect(result.connectionId).toBe('connection-1');
});

test('useApproveDeviceAuth types connectionId as null when the approval named no project', () => {
  type ApproveResult = Awaited<ReturnType<ReturnType<typeof tunnel.useApproveDeviceAuth>['mutateAsync']>>;
  // The server answers `connectionId: null` for an approval without a project.
  const noProject: ApproveResult = { success: true, tunnelId: 'tunnel-1', connectionId: null };
  expect(noProject.connectionId).toBeNull();
});

test('useApproveDeviceAuth leaves project_id and share out when the caller omits them', async () => {
  const config = tunnel.useApproveDeviceAuth() as unknown as Config;
  await config.mutationFn!({ code: 'ABCD-1234', capabilities: ['filesystem'] });
  expect(requests[0]?.body).toEqual({ capabilities: ['filesystem'] });
});

test('useAddComputerToProject POSTs the machine to the project and refreshes connections', async () => {
  const config = tunnel.useAddComputerToProject() as unknown as Config;
  const vars = { projectId: 'project-1', tunnelId: 'tunnel-1', share: 'me' as const };
  await config.mutationFn!(vars);
  expect(requests).toEqual([
    { method: 'POST', path: '/projects/project-1/computers', body: { tunnel_id: 'tunnel-1', share: 'me' } },
  ]);
  config.onSuccess!({}, vars);
  expect(invalidated).toContainEqual(['connections', 'project-1']);
  expect(invalidated).toContainEqual([...tunnel.tunnelKeys.connections()]);
});

test('the machine hooks backed by live routes still send their request', async () => {
  await (tunnel.useTunnelConnections() as unknown as Config).queryFn!();
  await (tunnel.useDeleteTunnelConnection() as unknown as Config).mutationFn!('tunnel-1');
  await (tunnel.useUpdateTunnelConnection() as unknown as Config).mutationFn!({ tunnelId: 'tunnel-1', name: 'Desk' });
  expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
    'GET /tunnel/connections',
    'DELETE /tunnel/connections/tunnel-1',
    'PATCH /tunnel/connections/tunnel-1',
  ]);
});

test('unpairing a machine refreshes every project connection list (its accounts are revoked)', async () => {
  const config = tunnel.useDeleteTunnelConnection() as unknown as Config;
  config.onSuccess!(undefined, 'tunnel-1');
  expect(invalidated).toContainEqual(['connections']);
});

test('a listed machine names the human who paired it', async () => {
  // `ownerUserId` is null for a machine paired before computers became
  // per-member accounts; hosts offer it to account managers only.
  const machine: TunnelConnection = {
    tunnelId: 'tunnel-1',
    accountId: 'account-1',
    sandboxId: null,
    name: 'Studio Mac',
    status: 'online',
    capabilities: ['filesystem'],
    machineInfo: {},
    lastHeartbeatAt: null,
    isLive: true,
    createdAt: '2026-09-28T10:00:00.000Z',
    updatedAt: '2026-09-28T10:00:00.000Z',
    ownerUserId: 'user-1',
  };
  expect(machine.ownerUserId).toBe('user-1');
});

test('useTunnelConnections polls every 5 s by default and accepts a slower interval', () => {
  expect((tunnel.useTunnelConnections() as Config).refetchInterval).toBe(5_000);
  expect((tunnel.useTunnelConnections({ refetchInterval: 60_000 }) as Config).refetchInterval).toBe(60_000);
  expect((tunnel.useTunnelConnections({ refetchInterval: false }) as Config).refetchInterval).toBe(false);
});
