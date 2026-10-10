import { beforeEach, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import {
  createApp,
  createAppAccessSession,
  createAppDeployment,
  deleteApp,
  deleteAppDeployment,
  finalizeAppArtifact,
  getApp,
  getAppAccess,
  getAppDeployment,
  getAppDeploymentLogs,
  listAppAgents,
  listAppDeployments,
  listApps,
  registerAppArtifact,
  rollbackApp,
  startApp,
  stopApp,
  updateApp,
  updateAppAccess,
  uploadAppArtifactArchive,
  type App,
  type AppDeployment,
  type AppImageRelease,
  type CreateAppInput,
  type UpdateAppInput,
  type DeleteAppDeploymentResult,
  type AppAccessMode,
  type AppHostingProvider,
  type UpdateAppAccessInput,
  type AppAuth,
  type AppCapability,
  type AppInstance,
  type AppKind,
  type AppSnapshots,
  type AppCredentials,
  type AppToken,
  type DeleteAppResult,
  createAppSnapshot,
  createAppToken,
  deleteAppSnapshot,
  getAppCredentials,
  getAppLog,
  listAppSnapshots,
  restoreAppSnapshot,
  rotateAppCredentials,
  waitForApp,
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
  const retiredProvider = ['local', 'docker'].join('-');
  // @ts-expect-error a retired provider id is not an Apps hosting provider.
  const provider: AppHostingProvider = retiredProvider;
  expect(provider as string).toBe(retiredProvider);
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

test('an App names the Apps it uses and the Apps that use it; create and update send `uses`', async () => {
  const app = { app_id: 'app-1', uses: ['db'], used_by: [] as string[] } as App;
  const uses: string[] | undefined = app.uses;
  const usedBy: string[] | undefined = app.used_by;
  expect(uses).toEqual(['db']);
  expect(usedBy).toEqual([]);
  responses.push({ status: 201, body: app }, { body: app });

  const created: CreateAppInput = { slug: 'crm', name: 'CRM', uses: ['db'] };
  await createApp('project-1', created);
  expect(last()).toMatchObject({ method: 'POST', body: { slug: 'crm', name: 'CRM', uses: ['db'] } });

  const update: UpdateAppInput = { uses: [] };
  await updateApp('project-1', 'app-1', update);
  expect(last()).toMatchObject({ method: 'PATCH', url: 'http://backend.test/v1/projects/project-1/apps/app-1', body: { uses: [] } });
});

test('an App carries its kind, capabilities, sign-in values and instance; create sends the kind', async () => {
  const app = {
    app_id: 'app-2',
    kind: 'convex',
    capabilities: ['deployments', 'snapshots', 'restore', 'admin_credentials', 'dashboard', 'logs', 'member_tokens'],
    auth: {
      issuer: 'https://api.test/v1/projects/project-1',
      audience: 'app-2',
      jwks_uri: 'https://api.test/v1/projects/project-1/jwks.json',
    },
    hosting_type: 'convex',
    instance: {
      status: 'running',
      url: 'https://db.apps.test',
      site_url: 'https://db-site.apps.test',
      dashboard_url: 'https://db-dashboard.apps.test',
      error: null,
      operation: null,
      last_operation_error: null,
      health: null,
      auth_env: null,
      client_version: '1.46.0',
      budget_alert: { month: '2026-10', percent: 80, spent_usd: 4, budget_usd: 5, at: '2026-10-09T00:00:00.000Z' },
      purge_after: null,
    },
  } as App;
  responses.push({ status: 201, body: app });

  const kind: AppKind | undefined = app.kind;
  const capabilities: AppCapability[] | undefined = app.capabilities;
  const instance: AppInstance | null | undefined = app.instance;
  const auth: AppAuth | undefined = app.auth;
  expect(kind).toBe('convex');
  expect(capabilities).toContain('snapshots');
  expect(instance?.status).toBe('running');
  expect(auth?.audience).toBe('app-2');

  const created = await createApp('project-1', { slug: 'db', name: 'db', kind: 'convex', cpu: 2 });
  expect(last()).toMatchObject({ method: 'POST', body: { slug: 'db', name: 'db', kind: 'convex', cpu: 2 } });
  expect(created.instance?.url).toBe('https://db.apps.test');
});

test('AppKind is exactly web or convex', () => {
  const exact: Equal<AppKind, 'web' | 'convex'> = true;
  expect(exact).toBe(true);
});

test('App access reads, updates, and creates a browser exchange URL through project-scoped REST routes', async () => {
  const policy = {
    mode: 'restricted' as const,
    revision: 4,
    member_ids: ['11111111-1111-4111-8111-111111111111'],
    group_ids: [],
    password_configured: false,
    viewer_token_scope: 'identity' as const,
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
    viewer_token_scope: 'api',
  })).toEqual({ ...policy, revision: 5 });
  expect(last()).toMatchObject({
    method: 'PATCH',
    url: 'http://backend.test/v1/projects/project-1/apps/app-1/access',
    body: { mode: 'restricted', member_ids: policy.member_ids, viewer_token_scope: 'api' },
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

test('listAppAgents reads the agents whose kortix.yaml `apps:` grant names the App', async () => {
  const agents = [
    { agent_name: 'report-writer', grant: 'listed' as const, path: 'kortix.yaml#agents.report-writer' },
    { agent_name: 'ops', grant: 'all' as const, path: 'kortix.yaml#agents.ops' },
  ];
  responses.push({ body: { agents } });

  expect(await listAppAgents('project-1', 'app-1')).toEqual(agents);
  expect(last()).toMatchObject({
    method: 'GET',
    url: 'http://backend.test/v1/projects/project-1/apps/app-1/agents',
  });
});

test('deleteApp returns how many deployment images the delete freed', async () => {
  const images: AppImageRelease = { released: 3, pending: 1 };
  responses.push({ body: { ok: true, images } });

  const result = await deleteApp('project-1', 'app-1');

  expect(last()).toMatchObject({
    method: 'DELETE',
    url: 'http://backend.test/v1/projects/project-1/apps/app-1',
  });
  expect(result).toEqual({ ok: true, images });
});

test('deleteAppDeployment deletes one deployment and reports its image outcome', async () => {
  const deleted: DeleteAppDeploymentResult = {
    ok: true,
    deployment_id: 'deployment-1',
    image: 'released',
  };
  responses.push({ body: deleted });

  const result = await deleteAppDeployment('project-1', 'app-1', 'deployment-1');

  expect(last()).toMatchObject({
    method: 'DELETE',
    url: 'http://backend.test/v1/projects/project-1/apps/app-1/deployments/deployment-1',
  });
  expect(result).toEqual(deleted);
});

test('deleteAppDeployment surfaces the 409 for the live deployment', async () => {
  responses.push({
    status: 409,
    body: {
      error: 'This deployment serves live traffic. Roll back to another deployment first, or delete the App.',
      code: 'deployment_live',
    },
  });

  await expect(deleteAppDeployment('project-1', 'app-1', 'deployment-1')).rejects.toMatchObject({
    status: 409,
  });
});

test('DeleteAppDeploymentResult.image is exactly released, pending, or none', () => {
  const exact: Equal<DeleteAppDeploymentResult['image'], 'released' | 'pending' | 'none'> = true;
  expect(exact).toBe(true);
});

test('an App runs always-on or on demand: create and update send always_on, and the App reads it back', async () => {
  const app: import('./apps').App = {
    app_id: 'app-1', account_id: 'account-1', project_id: 'project-1', slug: 'demo', name: 'Demo',
    url: 'https://demo.apps.kortix.com', access_mode: 'private', access_revision: 1, desired_state: 'running',
    active_deployment_id: null, machine: { cpu: 1, memory_gb: 2, disk_gb: 10 }, idle_timeout_seconds: 300,
    always_on: false, monthly_budget_usd: 5, last_request_at: null,
    created_at: '2026-10-07T00:00:00.000Z', updated_at: '2026-10-07T00:00:00.000Z',
  };
  responses.push({ status: 201, body: { ...app, always_on: true } }, { body: app });
  expect((await createApp('project-1', { slug: 'demo', name: 'Demo', always_on: true })).always_on).toBe(true);
  expect(last().body).toMatchObject({ always_on: true });
  expect((await updateApp('project-1', 'app-1', { always_on: false })).always_on).toBe(false);
  expect(last().body).toEqual({ always_on: false });
});

test('only an on-demand App has a budget: an always-on App reads monthly_budget_usd null and its monthly cost', async () => {
  const app: import('./apps').App = {
    app_id: 'app-1', account_id: 'account-1', project_id: 'project-1', slug: 'demo', name: 'Demo',
    url: 'https://demo.apps.kortix.com', access_mode: 'private', access_revision: 1, desired_state: 'running',
    active_deployment_id: null, machine: { cpu: 1, memory_gb: 2, disk_gb: 10 }, idle_timeout_seconds: 300,
    always_on: true, monthly_budget_usd: null, estimated_monthly_usd: 73.48, last_request_at: null, warnings: [],
    created_at: '2026-10-07T00:00:00.000Z', updated_at: '2026-10-07T00:00:00.000Z',
  };
  const budget: Equal<App['monthly_budget_usd'], number | null> = true;
  expect(budget).toBe(true);
  responses.push({ status: 201, body: app }, { body: { ...app, always_on: false, monthly_budget_usd: 5 } });
  const created = await createApp('project-1', { slug: 'demo', name: 'Demo' });
  expect(created.monthly_budget_usd).toBeNull();
  expect(created.estimated_monthly_usd).toBe(73.48);
  expect((await updateApp('project-1', 'app-1', { always_on: false })).monthly_budget_usd).toBe(5);
});

test('a budget on an always-on App: the server answers 400 app_budget_not_applicable and the SDK rejects with it', async () => {
  responses.push({
    status: 400,
    body: { error: 'An always-on App has no monthly budget: it runs 24/7 at a fixed cost (about $73.48 a month).', code: 'app_budget_not_applicable', estimated_monthly_usd: 73.48 },
  });
  await expect(updateApp('project-1', 'app-1', { monthly_budget_usd: 50 })).rejects.toMatchObject({ status: 400 });
});

test('an App says how its active deployment is hosted: hosting_type', async () => {
  const app = {
    app_id: 'app-1', account_id: 'account-1', project_id: 'project-1', slug: 'site', name: 'Site',
    url: 'https://site.apps.kortix.com', access_mode: 'public', access_revision: 1, desired_state: 'stopped',
    active_deployment_id: 'deployment-1', machine: { cpu: 1, memory_gb: 2, disk_gb: 10 }, idle_timeout_seconds: 300,
    monthly_budget_usd: 5, estimated_monthly_usd: 0, hosting_type: 'static', retained_deployments: 5, last_request_at: null,
    created_at: '2026-10-07T00:00:00.000Z', updated_at: '2026-10-07T00:00:00.000Z',
  } satisfies import('./apps').App;
  responses.push({ body: { apps: [app] } });
  const [listed] = await listApps('project-1');
  const hosting: import('./apps').App['hosting_type'] = listed!.hosting_type;
  expect(hosting).toBe('static');
  const retained: number | undefined = listed!.retained_deployments;
  expect(retained).toBe(5);
});

test('a static deployment says so: hosting_type static', () => {
  const hosting: import('./apps').AppDeployment['hosting_type'] = 'static';
  expect(hosting).toBe('static');
});

test('deleteApp sends the typed slug and reads what a retained delete keeps', async () => {
  const kept: DeleteAppResult = {
    ok: true,
    images: { released: 0, pending: 0 },
    retained_until: '2026-10-16T00:00:00.000Z',
    final_snapshot_id: 'snap-final',
  };
  responses.push({ body: kept });

  const result = await deleteApp('project-1', 'app-1', { confirm: 'my db' });

  expect(last()).toMatchObject({
    method: 'DELETE',
    url: 'http://backend.test/v1/projects/project-1/apps/app-1?confirm=my%20db',
  });
  expect(result).toEqual(kept);
});

test('a deployment without an artifact records what the client CLI deployed', async () => {
  responses.push({ status: 201, body: { deployment_id: 'deployment-9', artifact_id: null, source_kind: 'convex', hosting_type: 'convex' } });

  const deployment = await createAppDeployment('project-1', 'app-1', { source: { kind: 'convex', revision: 'abc123' } });

  expect(last()).toMatchObject({
    method: 'POST',
    url: 'http://backend.test/v1/projects/project-1/apps/app-1/deployments',
    body: { source: { kind: 'convex', revision: 'abc123' } },
  });
  const artifact: string | null = deployment.artifact_id;
  expect(artifact).toBeNull();
  expect(deployment.source_kind).toBe('convex');
  expect(deployment.hosting_type).toBe('convex');
});

test('snapshots: list, take, delete and restore use the App capability routes', async () => {
  const listed: AppSnapshots = {
    automatic: { state: 'ok', last_backup_at: null, size_bytes: null, interval_minutes: 60 },
    snapshots: [{ snapshot_id: 'snap/1', created_at: '2026-10-09T00:00:00.000Z', size_bytes: 10, kind: 'final', expires_at: '2026-10-16T00:00:00.000Z' }],
    snapshot_limit: 10,
    snapshot_schedule: { automatic_interval_hours: 24, automatic_retention_days: 7, resize_retention_hours: 24, last_automatic_at: null },
  };
  responses.push(
    { body: listed },
    { status: 201, body: listed.snapshots[0] },
    { status: 204, body: null },
    { body: { app_id: 'app-1', kind: 'convex' } },
  );

  expect(await listAppSnapshots('project-1', 'app-1')).toEqual(listed);
  expect(last()).toMatchObject({ method: 'GET', url: 'http://backend.test/v1/projects/project-1/apps/app-1/snapshots' });

  const taken = await createAppSnapshot('project-1', 'app-1');
  expect(last()).toMatchObject({ method: 'POST', url: 'http://backend.test/v1/projects/project-1/apps/app-1/snapshots' });
  expect(taken.kind).toBe('final');

  await deleteAppSnapshot('project-1', 'app-1', 'snap/1');
  expect(last()).toMatchObject({ method: 'DELETE', url: 'http://backend.test/v1/projects/project-1/apps/app-1/snapshots/snap%2F1' });

  const restored = await restoreAppSnapshot('project-1', 'app-1', 'snap/1');
  expect(last()).toMatchObject({
    method: 'POST',
    url: 'http://backend.test/v1/projects/project-1/apps/app-1/restore',
    body: { snapshot_id: 'snap/1' },
  });
  expect(restored.app_id).toBe('app-1');
});

test('admin credentials: read and rotate', async () => {
  const credentials: AppCredentials = {
    url: 'https://db.apps.test',
    site_url: 'https://db-site.apps.test',
    admin_key: 'synthetic-admin-key',
    env: { CONVEX_SELF_HOSTED_URL: 'https://db.apps.test', CONVEX_SELF_HOSTED_ADMIN_KEY: 'synthetic-admin-key' },
  };
  responses.push({ body: credentials }, { body: { app_id: 'app-1' } });

  expect(await getAppCredentials('project-1', 'app-1')).toEqual(credentials);
  expect(last()).toMatchObject({ method: 'GET', url: 'http://backend.test/v1/projects/project-1/apps/app-1/credentials' });

  const rotated = await rotateAppCredentials('project-1', 'app-1');
  expect(last()).toMatchObject({ method: 'POST', url: 'http://backend.test/v1/projects/project-1/apps/app-1/rotate-credentials' });
  expect(rotated.app_id).toBe('app-1');
});

test('createAppToken mints a sign-in token for the App naming the caller', async () => {
  const minted: AppToken = { token: 'header.payload.signature', expires_at: '2026-10-09T00:15:00.000Z' };
  responses.push({ body: minted });

  expect(await createAppToken('project-1', 'app-1')).toEqual(minted);
  expect(last()).toMatchObject({ method: 'POST', url: 'http://backend.test/v1/projects/project-1/apps/app-1/token' });
});

test('getAppLog reads the end of the App process log', async () => {
  responses.push({ body: { log: 'line 1\nline 2\n' } }, { body: { log: '' } });

  expect(await getAppLog('project-1', 'app-1', { lines: 50 })).toBe('line 1\nline 2\n');
  expect(last()).toMatchObject({ method: 'GET', url: 'http://backend.test/v1/projects/project-1/apps/app-1/logs?lines=50' });
  await getAppLog('project-1', 'app-1');
  expect(last().url).toBe('http://backend.test/v1/projects/project-1/apps/app-1/logs?lines=200');
});

const instanceApp = (instance: Partial<AppInstance> | null) => ({
  app_id: 'app-1',
  slug: 'db',
  instance: instance && { status: 'running', operation: null, last_operation_error: null, error: null, ...instance },
});

test('waitForApp resolves once the instance runs with no operation in flight', async () => {
  responses.push(
    { body: instanceApp({ status: 'provisioning' }) },
    { body: instanceApp({ operation: 'resizing' }) },
    { body: instanceApp({}) },
  );

  const app = await waitForApp('project-1', 'app-1', { intervalMs: 1 });

  expect(calls).toHaveLength(3);
  expect(calls.every((call) => call.url === 'http://backend.test/v1/projects/project-1/apps/app-1')).toBe(true);
  expect(app.instance?.status).toBe('running');
});

test('waitForApp resolves at once for an App without an instance', async () => {
  responses.push({ body: instanceApp(null) });
  expect((await waitForApp('project-1', 'app-1', { intervalMs: 1 })).app_id).toBe('app-1');
  expect(calls).toHaveLength(1);
});

test('waitForApp rejects with the instance error and with a new operation error', async () => {
  responses.push({ body: instanceApp({ status: 'error', error: 'image build failed' }) });
  await expect(waitForApp('project-1', 'app-1', { intervalMs: 1 })).rejects.toThrow('image build failed');

  responses.push(
    { body: instanceApp({ operation: 'resizing', last_operation_error: 'old failure' }) },
    { body: instanceApp({ last_operation_error: 'resize failed: disk' }) },
  );
  await expect(waitForApp('project-1', 'app-1', { intervalMs: 1 })).rejects.toThrow('resize failed: disk');
});

test('waitForApp rejects after its timeout while the instance is still busy', async () => {
  for (let i = 0; i < 20; i++) responses.push({ body: instanceApp({ status: 'provisioning' }) });
  await expect(waitForApp('project-1', 'app-1', { intervalMs: 1, timeoutMs: 5 })).rejects.toThrow('db is still provisioning');
});
