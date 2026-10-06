import { beforeEach, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import {
  createBackend,
  createBackendSnapshot,
  deleteBackend,
  getBackendBackups,
  resizeBackend,
  restoreBackendSnapshot,
  waitForBackendOperation,
  getBackend,
  getBackendCredentials,
  getBackendToken,
  listBackends,
  waitForBackend,
  type ProjectBackend,
  type ProjectBackendCredentials,
} from './backends';

type Call = { url: string; method: string; body: unknown };

let calls: Call[] = [];
let responses: Array<{ status?: number; body?: unknown }> = [];

beforeEach(() => {
  calls = [];
  responses = [];
  configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => 'token' });
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = init?.body;
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof raw === 'string' ? JSON.parse(raw) : undefined,
    });
    const response = responses.shift() ?? { body: {} };
    if (response.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

const last = () => calls.at(-1)!;

const backend: ProjectBackend = {
  backend_id: '11111111-1111-4111-8111-111111111111',
  project_id: 'project-1',
  name: 'main',
  status: 'running',
  url: 'https://b.example.test',
  site_url: 'https://b-site.example.test',
  cpu: 1,
  memory_gb: 2,
  disk_gb: 10,
  error: null,
  operation: null,
  last_operation_error: null,
  created_at: '2026-10-06T00:00:00.000Z',
  updated_at: '2026-10-06T00:00:00.000Z',
};

test('Backends use the project-scoped API contract', async () => {
  const credentials: ProjectBackendCredentials = {
    url: backend.url!,
    site_url: backend.site_url!,
    admin_key: 'admin-key',
    env: { CONVEX_SELF_HOSTED_URL: backend.url!, CONVEX_SELF_HOSTED_ADMIN_KEY: 'admin-key' },
  };
  responses.push(
    { body: { backends: [backend] } },
    { status: 201, body: { backend } },
    { body: { backend } },
    { body: credentials },
    { status: 204 },
  );

  expect(await listBackends('project-1')).toEqual([backend]);
  expect(last()).toMatchObject({ method: 'GET', url: 'http://backend.test/v1/projects/project-1/backends' });

  expect(await createBackend('project-1', { name: 'main' })).toEqual(backend);
  expect(last()).toMatchObject({
    method: 'POST',
    url: 'http://backend.test/v1/projects/project-1/backends',
    body: { name: 'main' },
  });

  expect(await getBackend('project-1', backend.backend_id)).toEqual(backend);
  expect(last().url).toBe(`http://backend.test/v1/projects/project-1/backends/${backend.backend_id}`);

  expect(await getBackendCredentials('project-1', backend.backend_id)).toEqual(credentials);
  expect(last().url).toBe(
    `http://backend.test/v1/projects/project-1/backends/${backend.backend_id}/credentials`,
  );

  await deleteBackend('project-1', backend.backend_id);
  expect(last()).toMatchObject({
    method: 'DELETE',
    url: `http://backend.test/v1/projects/project-1/backends/${backend.backend_id}`,
  });
});

test('Backend errors carry the API code', async () => {
  responses.push({ status: 409, body: { error: 'limit', code: 'backend_limit' } });
  await expect(createBackend('project-1', { name: 'd' })).rejects.toMatchObject({ code: 'backend_limit' });
});

test('waitForBackend polls until the backend runs', async () => {
  responses = [
    { body: { backend: { ...backend, status: 'provisioning', url: null, site_url: null } } },
    { body: { backend: { ...backend, status: 'provisioning', url: null, site_url: null } } },
    { body: { backend } },
  ];
  const result = await waitForBackend('project-1', backend.backend_id, { intervalMs: 1 });
  expect(result.status).toBe('running');
  expect(result.url).toBe(backend.url);
  expect(calls).toHaveLength(3);
  expect(calls.every((c) => c.method === 'GET' && c.url.endsWith(`/projects/project-1/backends/${backend.backend_id}`))).toBe(true);
});

test('waitForBackend rejects with the backend error when provisioning fails', async () => {
  responses = [{ body: { backend: { ...backend, status: 'error', url: null, error: 'boom' } } }];
  await expect(waitForBackend('project-1', backend.backend_id, { intervalMs: 1 })).rejects.toThrow('boom');
});

test('waitForBackend gives up after its timeout', async () => {
  responses = Array.from({ length: 50 }, () => ({ body: { backend: { ...backend, status: 'provisioning' } } }));
  await expect(
    waitForBackend('project-1', backend.backend_id, { intervalMs: 5, timeoutMs: 20 }),
  ).rejects.toThrow(/still provisioning/);
});

test('getBackendToken POSTs to the token route and returns the JWT', async () => {
  responses = [{ body: { token: 'h.p.s', expires_at: '2026-10-06T01:00:00.000Z' } }];
  const minted = await getBackendToken('project-1', backend.backend_id);
  expect(minted).toEqual({ token: 'h.p.s', expires_at: '2026-10-06T01:00:00.000Z' });
  expect(last().method).toBe('POST');
  expect(last().url).toEndWith(`/projects/project-1/backends/${backend.backend_id}/token`);
});

const base = `http://backend.test/v1/projects/project-1/backends/${backend.backend_id}`;

test('resizeBackend PATCHes the size and returns the resizing backend', async () => {
  responses = [{ status: 202, body: { backend: { ...backend, operation: 'resizing' } } }];
  const result = await resizeBackend('project-1', backend.backend_id, { cpu: 2, memory_gb: 4 });
  expect(result.operation).toBe('resizing');
  expect(last()).toMatchObject({ method: 'PATCH', url: base, body: { cpu: 2, memory_gb: 4 } });
});

test('resizeBackend surfaces the API error code', async () => {
  responses = [{ status: 400, body: { error: 'same', code: 'size_unchanged' } }];
  await expect(resizeBackend('project-1', backend.backend_id, { cpu: 1 })).rejects.toMatchObject({
    code: 'size_unchanged',
  });
});

test('getBackendBackups, createBackendSnapshot and restoreBackendSnapshot use the backup routes', async () => {
  const backups = {
    automatic: { state: 'ok', last_backup_at: null, size_bytes: null, interval_minutes: 60 },
    snapshots: [{ snapshot_id: 's1', created_at: '2026-10-06T00:00:00.000Z', size_bytes: 10 }],
  };
  responses = [
    { body: backups },
    { status: 201, body: { snapshot_id: 's2', created_at: '2026-10-06T00:01:00.000Z' } },
    { body: { backend } },
  ];
  expect(await getBackendBackups('project-1', backend.backend_id)).toEqual(backups);
  expect(last()).toMatchObject({ method: 'GET', url: `${base}/backups` });
  expect((await createBackendSnapshot('project-1', backend.backend_id)).snapshot_id).toBe('s2');
  expect(last()).toMatchObject({ method: 'POST', url: `${base}/snapshots` });
  expect(await restoreBackendSnapshot('project-1', backend.backend_id, 's1')).toEqual(backend);
  expect(last()).toMatchObject({ method: 'POST', url: `${base}/restore`, body: { snapshot_id: 's1' } });
});

test('waitForBackendOperation polls until the operation clears', async () => {
  const busy = { ...backend, operation: 'resizing' };
  responses = [{ body: { backend: busy } }, { body: { backend: { ...backend, cpu: 2 } } }];
  const result = await waitForBackendOperation('project-1', backend.backend_id, { intervalMs: 1 });
  expect(result.cpu).toBe(2);
  expect(calls).toHaveLength(2);
});

test('waitForBackendOperation rejects with last_operation_error when the operation failed', async () => {
  responses = [
    { body: { backend: { ...backend, operation: 'resizing' } } },
    { body: { backend: { ...backend, last_operation_error: 'out of capacity' } } },
  ];
  await expect(
    waitForBackendOperation('project-1', backend.backend_id, { intervalMs: 1 }),
  ).rejects.toThrow('out of capacity');
});

test('waitForBackendOperation gives up after its timeout', async () => {
  responses = Array.from({ length: 50 }, () => ({ body: { backend: { ...backend, operation: 'resizing' } } }));
  await expect(
    waitForBackendOperation('project-1', backend.backend_id, { intervalMs: 5, timeoutMs: 20 }),
  ).rejects.toThrow(/still resizing/);
});
