import { beforeEach, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import {
  createApp,
  createAppAccessSession,
  createAppDeployment,
  deleteApp,
  finalizeAppArtifact,
  getApp,
  getAppAccess,
  getAppDeployment,
  getAppDeploymentLogs,
  listAppDeployments,
  listApps,
  registerAppArtifact,
  rollbackApp,
  startApp,
  stopApp,
  updateApp,
  updateAppAccess,
  uploadAppArtifactArchive,
  type AppDeployment,
  type AppAccessMode,
  type AppHostingProvider,
  type UpdateAppAccessInput,
} from './apps';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? true
    : false;

type Call = { url: string; method: string; body: unknown; headers: Headers };

let calls: Call[] = [];
let responses: Array<{ status?: number; body: unknown }> = [];

beforeEach(() => {
  calls = [];
  responses = [];
  configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => 'token' });
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const rawBody = init?.body;
    let body: unknown;
    if (typeof rawBody === 'string') body = JSON.parse(rawBody);
    else if (rawBody instanceof Uint8Array) body = rawBody;
    else if (rawBody instanceof Blob) body = new Uint8Array(await rawBody.arrayBuffer());
    calls.push({ url: String(input), method: init?.method ?? 'GET', body, headers });
    const response = responses.shift() ?? { body: {} };
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

const last = () => calls.at(-1)!;

test('AppHostingProvider is exactly the supported hosted provider set', () => {
  const exactProviderSet: Equal<AppHostingProvider, 'daytona' | 'platinum' | 'e2b'> = true;
  expect(exactProviderSet).toBe(true);
});

test('AppDeployment exposes the immutable deploying actor', () => {
  const deployment = {
    created_by: 'user-1',
    source_session_id: 'session-1',
    actor_type: 'agent',
  } as AppDeployment;
  expect(deployment.created_by).toBe('user-1');
  expect(deployment.source_session_id).toBe('session-1');
  expect(deployment.actor_type).toBe('agent');
});

test('Apps hosting excludes the retired same-machine provider', () => {
  // @ts-expect-error local-docker is not a supported Apps hosting provider.
  const provider: AppHostingProvider = 'local-docker';
  expect(provider as string).toBe('local-docker');
});

test('Apps publishes default-private access modes and grant inputs', () => {
  const modes: AppAccessMode[] = ['private', 'project', 'restricted', 'public', 'password'];
  const input: UpdateAppAccessInput = {
    mode: 'restricted',
    member_ids: ['11111111-1111-4111-8111-111111111111'],
    group_ids: [],
  };
  expect(modes).toHaveLength(5);
  expect(input.mode).toBe('restricted');
});

test('Apps CRUD uses the project-scoped API contract', async () => {
  const app = {
    app_id: 'app-1',
    account_id: 'account-1',
    project_id: 'project-1',
    slug: 'demo',
    name: 'Demo',
    url: 'https://demo.apps.kortix.com',
    access_mode: 'private' as const,
    access_revision: 1,
    desired_state: 'running' as const,
    active_deployment_id: null,
    machine: { cpu: 1, memory_gb: 2, disk_gb: 10 },
    idle_timeout_seconds: 300,
    monthly_budget_usd: 5,
    last_request_at: null,
    created_at: '2026-08-07T00:00:00.000Z',
    updated_at: '2026-08-07T00:00:00.000Z',
  };
  responses.push(
    { body: { apps: [app] } },
    { status: 201, body: app },
    { body: app },
    { body: { ...app, name: 'Renamed' } },
    { body: { ok: true } },
  );

  expect(await listApps('project-1')).toEqual([app]);
  expect(last()).toMatchObject({ method: 'GET', url: 'http://backend.test/v1/projects/project-1/apps' });

  await createApp('project-1', { slug: 'demo', name: 'Demo' });
  expect(last()).toMatchObject({
    method: 'POST',
    url: 'http://backend.test/v1/projects/project-1/apps',
    body: { slug: 'demo', name: 'Demo' },
  });

  await getApp('project-1', 'app-1');
  expect(last().url).toBe('http://backend.test/v1/projects/project-1/apps/app-1');

  await updateApp('project-1', 'app-1', { name: 'Renamed' });
  expect(last()).toMatchObject({ method: 'PATCH', body: { name: 'Renamed' } });

  await deleteApp('project-1', 'app-1');
  expect(last().method).toBe('DELETE');
});

test('App access reads, updates, and creates a browser exchange URL through project-scoped REST routes', async () => {
  const policy = {
    mode: 'restricted' as const,
    revision: 4,
    member_ids: ['11111111-1111-4111-8111-111111111111'],
    group_ids: [],
    password_configured: false,
  };
  const session = {
    url: 'https://dev-demo-aaaaaaaaaaaaaaaa.apps.kortix.com/?__kortix_access=token',
    expires_at: '2026-08-07T20:05:00.000Z',
  };
  responses.push({ body: policy }, { body: { ...policy, revision: 5 } }, { body: session });

  expect(await getAppAccess('project-1', 'app-1')).toEqual(policy);
  expect(last()).toMatchObject({
    method: 'GET',
    url: 'http://backend.test/v1/projects/project-1/apps/app-1/access',
  });

  expect(await updateAppAccess('project-1', 'app-1', {
    mode: 'restricted',
    member_ids: policy.member_ids,
  })).toEqual({ ...policy, revision: 5 });
  expect(last()).toMatchObject({
    method: 'PATCH',
    url: 'http://backend.test/v1/projects/project-1/apps/app-1/access',
    body: { mode: 'restricted', member_ids: policy.member_ids },
  });

  expect(await createAppAccessSession('project-1', 'app-1')).toEqual(session);
  expect(last()).toMatchObject({
    method: 'POST',
    url: 'http://backend.test/v1/projects/project-1/apps/app-1/access-session',
    body: {},
  });
});

test('artifact registration, finalization, and deployment preserve the wire spec', async () => {
  responses.push(
    { status: 201, body: { artifact: { artifact_id: 'artifact-1' }, upload: null } },
    { body: { artifact_id: 'artifact-1', status: 'uploaded' } },
    { status: 202, body: { deployment_id: 'deployment-1', status: 'queued' } },
  );

  await registerAppArtifact('project-1', { kind: 'oci_image', image: 'ghcr.io/kortix/demo:1' });
  expect(last().body).toEqual({ kind: 'oci_image', image: 'ghcr.io/kortix/demo:1' });

  await finalizeAppArtifact('project-1', 'artifact-1', {
    sha256: 'a'.repeat(64),
    size_bytes: 42,
  });
  expect(last()).toMatchObject({
    method: 'POST',
    url: 'http://backend.test/v1/projects/project-1/apps/artifacts/artifact-1/finalize',
  });

  await createAppDeployment('project-1', 'app-1', {
    artifact_id: 'artifact-1',
    source: {
      kind: 'dockerfile',
      dockerfile: 'Dockerfile.app',
      command: ['bun', 'run', 'start'],
      port: 3000,
      readiness_path: '/health',
      restart_limit: 3,
    },
    provider: 'daytona',
    environment: { NODE_ENVIRONMENT: 'production' },
    secrets: { DATABASE_URL: 'database-primary' },
  });
  expect(last().body).toEqual({
    artifact_id: 'artifact-1',
    source: {
      kind: 'dockerfile',
      dockerfile: 'Dockerfile.app',
      command: ['bun', 'run', 'start'],
      port: 3000,
      readiness_path: '/health',
      restart_limit: 3,
    },
    provider: 'daytona',
    environment: { NODE_ENVIRONMENT: 'production' },
    secrets: { DATABASE_URL: 'database-primary' },
  });
});

test('archive upload sends immutable bytes to the signed URL and finalizes their SHA-256', async () => {
  const bytes = new TextEncoder().encode('archive bytes');
  const progress: Array<[number, number]> = [];
  responses.push(
    {
      status: 201,
      body: {
        artifact: { artifact_id: 'artifact-1', status: 'uploading' },
        upload: { url: 'https://storage.test/object?token=signed', max_bytes: 1024 },
      },
    },
    { body: { Key: 'app-artifacts/object' } },
    { body: { artifact_id: 'artifact-1', status: 'uploaded', sha256: 'ignored' } },
  );

  await uploadAppArtifactArchive('project-1', bytes, {
    mediaType: 'application/gzip',
    onProgress: (sent, total) => progress.push([sent, total]),
  });

  expect(calls[1]).toMatchObject({
    method: 'PUT',
    url: 'https://storage.test/object?token=signed',
    body: bytes,
  });
  expect(calls[1]!.headers.get('authorization')).toBeNull();
  expect(calls[1]!.headers.get('content-type')).toBe('application/gzip');
  expect(calls[1]!.headers.get('x-upsert')).toBe('false');
  expect(calls[2]!.body).toEqual({
    sha256: 'cc9c340301ad4ba5e54aa24b442ff938d1ed84f7f32c4c5a73773c58af37bd1b',
    size_bytes: bytes.byteLength,
  });
  expect(progress).toEqual([[0, bytes.byteLength], [bytes.byteLength, bytes.byteLength]]);
});

test('deployment inspection, logs, lifecycle, and rollback use bound identifiers', async () => {
  responses.push(
    { body: { deployments: [{ deployment_id: 'deployment-1' }] } },
    { body: { deployment: { deployment_id: 'deployment-1' }, events: [] } },
    { body: { entries: [{ cursor: 4, line: 'ready' }], next_cursor: 4 } },
    { body: { app_id: 'app-1', desired_state: 'running' } },
    { body: { app_id: 'app-1', desired_state: 'stopped' } },
    { body: { app_id: 'app-1', active_deployment_id: 'deployment-1' } },
  );

  await listAppDeployments('project-1', 'app-1');
  await getAppDeployment('project-1', 'app-1', 'deployment-1');
  await getAppDeploymentLogs('project-1', 'app-1', 'deployment-1', { after: 3, limit: 50 });
  expect(last().url).toBe(
    'http://backend.test/v1/projects/project-1/apps/app-1/deployments/deployment-1/logs?after=3&limit=50',
  );
  await startApp('project-1', 'app-1');
  await stopApp('project-1', 'app-1');
  await rollbackApp('project-1', 'app-1', 'deployment-1');
  expect(last()).toMatchObject({ method: 'POST', body: { deployment_id: 'deployment-1' } });
});
