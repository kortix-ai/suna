import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const ORIGINAL_ENV = { ...process.env };
const PROJECT = '11111111-2222-4333-8444-555555555555';
const APP_ID = '99999999-8888-4777-8666-555555555555';

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let serverPort = 0;
let calls: Array<{ method: string; path: string; body: unknown }> = [];
let uploaded: Uint8Array | null = null;
/** Fields every App response carries in the current test. */
let appFields: Record<string, unknown> = {};
/** Project secrets that already hold a value. */
let configuredSecrets: string[] = [];
/** Slugs of the Apps created during the test (one id serves them all). */
let created: string[] = [];
/** The deployments route answers 400 app_config_invalid with these issues. */
let configIssues: Array<{ path: string; message: string }> | null = null;

function writeConfig(apiBase: string): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'tok_apps_deploy',
          user_id: 'user_1',
          user_email: 'user@example.test',
          account_id: 'account_1',
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
    'utf8',
  );
  return path;
}

function app(overrides: Record<string, unknown> = {}) {
  return {
    app_id: APP_ID,
    account_id: 'account_1',
    project_id: PROJECT,
    slug: 'storefront',
    name: 'Storefront',
    url: 'https://storefront.kortix.test',
    access_mode: 'private',
    access_revision: 1,
    desired_state: 'running',
    active_deployment_id: null,
    machine: { cpu: 1, memory_gb: 2, disk_gb: 10 },
    idle_timeout_seconds: 300,
    last_request_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...appFields,
    ...overrides,
  };
}

function deployment(overrides: Record<string, unknown> = {}) {
  return {
    deployment_id: 'dep-1',
    app_id: APP_ID,
    artifact_id: 'art-1',
    version: 1,
    status: 'ready',
    source_kind: 'bundle',
    hosting_type: 'sandbox',
    hosting_provider: 'daytona',
    runtime_spec: {},
    build_spec: {},
    error_code: null,
    error: null,
    attempt_count: 0,
    started_at: null,
    ready_at: null,
    failed_at: null,
    created_by: 'user_1',
    source_session_id: null,
    actor_type: 'human',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function artifact(kind: string, image: string | null) {
  return {
    artifact_id: 'art-1',
    project_id: PROJECT,
    kind,
    status: 'ready',
    image_reference: image,
    sha256: null,
    size_bytes: null,
    media_type: null,
    error: null,
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

function startServer(): string {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const path = url.pathname;
      const body =
        req.method === 'GET'
          ? null
          : path === '/upload-bucket/source.tar.gz'
            ? new Uint8Array(await req.arrayBuffer())
            : await req.json().catch(() => null);
      calls.push({ method: req.method, path, body });

      if (path === `/v1/projects/${PROJECT}` && req.method === 'GET') {
        return Response.json({
          project_id: PROJECT,
          account_id: 'account_1',
          name: 'Atlas',
          repo_url: 'https://example.test/r.git',
          default_branch: 'main',
          manifest_path: 'kortix.yaml',
          status: 'active',
          metadata: {},
          experimental: { apps: true },
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        });
      }
      if (path === `/v1/projects/${PROJECT}/apps` && req.method === 'GET') {
        return Response.json({ apps: created.map((slug) => app({ slug, name: slug })) });
      }
      if (path === `/v1/projects/${PROJECT}/apps` && req.method === 'POST') {
        const input = body as { slug: string; name: string };
        created.push(input.slug);
        return Response.json(app({ slug: input.slug, name: input.name }));
      }
      if (path === `/v1/projects/${PROJECT}/apps/artifacts` && req.method === 'POST') {
        const input = body as { kind: string; image?: string };
        if (input.kind === 'oci_image') {
          return Response.json({
            artifact: artifact('oci_image', input.image ?? null),
            upload: null,
          });
        }
        return Response.json({
          artifact: artifact('archive', null),
          upload: {
            url: `http://127.0.0.1:${serverPort}/upload-bucket/source.tar.gz`,
            max_bytes: 10_000_000,
          },
        });
      }
      if (path === '/upload-bucket/source.tar.gz' && req.method === 'PUT') {
        uploaded = body as Uint8Array;
        return new Response(null, { status: 200 });
      }
      if (
        path === `/v1/projects/${PROJECT}/apps/artifacts/art-1/finalize` &&
        req.method === 'POST'
      ) {
        return Response.json(artifact('archive', null));
      }
      if (path === `/v1/projects/${PROJECT}/apps/${APP_ID}/deployments` && req.method === 'POST') {
        if (configIssues) return Response.json({ error: 'The release config is invalid', code: 'app_config_invalid', issues: configIssues }, { status: 400 });
        return Response.json(deployment());
      }
      if (path === `/v1/projects/${PROJECT}/apps/${APP_ID}` && req.method === 'GET') {
        return Response.json(app());
      }
      if (path === `/v1/projects/${PROJECT}/apps/${APP_ID}` && req.method === 'PATCH') {
        return Response.json(app(body as Record<string, unknown>));
      }
      if (path === `/v1/projects/${PROJECT}/apps/${APP_ID}/exec` && req.method === 'POST') {
        return Response.json({ exit_code: 0, stdout: 'Admin key:\nsynthetic-admin-key|0123\n', stderr: '', truncated: false });
      }
      if (path === `/v1/projects/${PROJECT}/secrets` && req.method === 'GET') {
        return Response.json({ items: configuredSecrets.map((name) => ({ identifier: name, name, configured: true })), required: [], optional: [] });
      }
      if (path === `/v1/projects/${PROJECT}/secrets` && req.method === 'POST') {
        return Response.json({ identifier: (body as { name: string }).name, name: (body as { name: string }).name, configured: true });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  serverPort = server?.port ?? 0;
  return `http://127.0.0.1:${server.port}`;
}

async function runCli(args: string[], configFile?: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_CONFIG_FILE: configFile,
  };
  for (const key of [
    'KORTIX_API_URL',
    'KORTIX_CLI_TOKEN',
    'KORTIX_FRONTEND_URL',
    'KORTIX_PROJECT_ID',
    'KORTIX_TOKEN',
    'BASH_ENV',
  ]) {
    delete env[key];
  }
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: tmp,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), 15_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

function deploymentCall() {
  return calls.find((c) => c.method === 'POST' && c.path.endsWith('/deployments'));
}

describe('kortix apps deploy (characterization)', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-apps-deploy-'));
    process.env = { ...ORIGINAL_ENV };
    calls = [];
    uploaded = null;
    appFields = {};
    configuredSecrets = [];
    created = [];
    configIssues = null;
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('a manifest block seeds the App and deployment; an explicit flag wins over the manifest value', async () => {
    mkdirSync(join(tmp, 'web'), { recursive: true });
    writeFileSync(join(tmp, 'web', 'package.json'), '{"name":"web"}\n');
    writeFileSync(
      join(tmp, 'kortix.yaml'),
      [
        'kortix_version: 2',
        'apps:',
        '  storefront:',
        '    path: web',
        '    type: bundle',
        '    output_dir: dist',
        '    uses: [db]',
        '    resources:',
        '      cpu: 2',
        '      memory_gb: 4',
        '    env:',
        '      NODE_ENVIRONMENT: production',
        '    secrets:',
        '      DATABASE_URL: database-primary',
        '',
      ].join('\n'),
    );
    const config = writeConfig(startServer());
    const r = await runCli(
      ['apps', 'deploy', '--output-dir', 'build', '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(0);
    // No --manifest-app needed: a single apps block is the default. The App is
    // provisioned from the manifest's identity + resources.
    const create = calls.find(
      (c) => c.method === 'POST' && c.path === `/v1/projects/${PROJECT}/apps`,
    );
    expect(create?.body).toEqual({ slug: 'storefront', name: 'storefront', cpu: 2, memory_gb: 4, uses: ['db'] });
    // --output-dir wins over the manifest's output_dir; env and secrets pass through.
    expect(deploymentCall()?.body).toEqual({
      artifact_id: 'art-1',
      source: { kind: 'bundle', output_dir: 'build' },
      environment: { NODE_ENVIRONMENT: 'production' },
      secrets: { DATABASE_URL: 'database-primary' },
      // The block's release config: here only its machine size.
      config: { resources: { cpu: 2, memory_gb: 4 } },
    });
    expect(r.stdout).toContain('deployment ready');
    expect(r.stdout).toContain('storefront.kortix.test');
  });

  test('an explicit path still uses the matching kortix.yaml block (spa, mounts, services, labels, display reach the deploy)', async () => {
    mkdirSync(join(tmp, 'apps', 'web', 'dist'), { recursive: true });
    writeFileSync(join(tmp, 'apps', 'web', 'dist', 'index.html'), '<!doctype html>');
    mkdirSync(join(tmp, 'db'), { recursive: true });
    writeFileSync(join(tmp, 'db', 'Dockerfile'), 'FROM busybox\n');
    writeFileSync(join(tmp, 'kortix.yaml'), [
      'kortix_version: 2',
      'apps:',
      '  web:',
      '    path: apps/web/dist',
      '    type: static',
      '    spa: true',
      '  api:',
      '    path: db',
      '    type: dockerfile',
      '    command: ["/start.sh"]',
      '    labels: [backend]',
      '    display: { preview: none }',
      '    http_service: { internal_port: 3210, access: public }',
      '    services:',
      '      - { name: site, internal_port: 3211, access: public }',
      '    mounts:',
      '      - { source: data, destination: /data, initial_size_gb: 10 }',
      '',
    ].join('\n'));
    const config = writeConfig(startServer());
    // The fieldops agent did exactly this and lost `spa: true`.
    const web = await runCli(['apps', 'deploy', 'apps/web/dist', '--project', PROJECT], config);
    expect(web.code).toBe(0);
    expect((deploymentCall()?.body as { source: { spa?: boolean } }).source.spa).toBe(true);
    calls = [];
    // The path `db` is the `api` block's path: the block applies.
    const api = await runCli(['apps', 'deploy', 'db', '--project', PROJECT], config);
    expect(api.code).toBe(0);
    const body = deploymentCall()?.body as { source: Record<string, unknown>; config: Record<string, unknown> };
    expect(body.source).toMatchObject({ kind: 'dockerfile', command: ['/start.sh'], port: 3210 });
    expect(body.config).toEqual({
      http_service: { internal_port: 3210, access: 'public' },
      services: [{ name: 'site', internal_port: 3211, access: 'public' }],
      mounts: [{ source: 'data', destination: '/data', initial_size_gb: 10 }],
    });
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ labels: ['backend'], display: { preview: 'none' } });
  });

  test('launch --template convex: the dashboard is a tab of the backend, signed in by a secret the launch creates once', async () => {
    writeFileSync(join(tmp, 'kortix.yaml'), 'kortix_version: 2\n');
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'launch', '--template', 'convex', '--name', 'crm-data', '--project', PROJECT], config);
    expect(r.stderr).not.toContain('✗');
    expect(r.code).toBe(0);
    const yaml = Bun.YAML.parse(await Bun.file(join(tmp, 'kortix.yaml')).text()) as { apps: Record<string, Record<string, unknown>> };
    expect(yaml.apps['crm-data']!.display).toEqual({ preview: 'none' });
    expect(yaml.apps['crm-data-dashboard']!.display).toEqual({ parent: 'crm-data' });
    expect(yaml.apps['crm-data-dashboard']!.secrets).toEqual({ NEXT_PUBLIC_ADMIN_KEY: 'CRM_DATA_ADMIN_KEY' });
    expect(yaml.apps['crm-data-dashboard']!.path).toBe('apps/crm-data/dashboard');
    expect(r.stdout).toContain('wrote apps/crm-data/dashboard/start.js');
    // Backend first, then the key from its machine, then the dashboard that reads it.
    const order = calls.filter((c) => c.method === 'POST' && /\/(deployments|exec|secrets)$/.test(c.path)).map((c) => c.path.split('/').pop());
    expect(order).toEqual(['deployments', 'exec', 'secrets', 'deployments']);
    expect(calls.find((c) => c.path.endsWith('/secrets') && c.method === 'POST')?.body).toEqual({ name: 'CRM_DATA_ADMIN_KEY', value: 'synthetic-admin-key|0123' });
    expect(r.stdout + r.stderr).not.toContain('synthetic-admin-key');
    expect(r.stdout).toContain('CRM_DATA_ADMIN_KEY');
  });

  test('launch without --name names the Convex App for what it is: backend, backend-dashboard, BACKEND_ADMIN_KEY', async () => {
    writeFileSync(join(tmp, 'kortix.yaml'), 'kortix_version: 2\n');
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'launch', '--template', 'convex', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    const yaml = Bun.YAML.parse(await Bun.file(join(tmp, 'kortix.yaml')).text()) as { apps: Record<string, Record<string, unknown>> };
    expect(Object.keys(yaml.apps)).toEqual(['backend', 'backend-dashboard']);
    expect(yaml.apps['backend-dashboard']!.secrets).toEqual({ NEXT_PUBLIC_ADMIN_KEY: 'BACKEND_ADMIN_KEY' });
    expect(yaml.apps['backend-dashboard']!.path).toBe('apps/backend/dashboard');
  });

  test('launch rewrites a secret an earlier App of the same name left, and keeps a file the user already has', async () => {
    writeFileSync(join(tmp, 'kortix.yaml'), 'kortix_version: 2\n');
    mkdirSync(join(tmp, 'apps', 'crm-data', 'dashboard'), { recursive: true });
    writeFileSync(join(tmp, 'apps', 'crm-data', 'dashboard', 'start.js'), '// mine\n');
    configuredSecrets = ['CRM_DATA_ADMIN_KEY'];
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'launch', '--template', 'convex', '--name', 'crm-data', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls.some((c) => c.path.endsWith('/exec'))).toBe(true);
    expect(calls.find((c) => c.path.endsWith('/secrets') && c.method === 'POST')?.body).toEqual({ name: 'CRM_DATA_ADMIN_KEY', value: 'synthetic-admin-key|0123' });
    expect(readFileSync(join(tmp, 'apps', 'crm-data', 'dashboard', 'start.js'), 'utf8')).toBe('// mine\n');
    expect(readFileSync(join(tmp, 'apps', 'crm-data', 'dashboard', 'Dockerfile'), 'utf8')).toContain('ENV BACKEND=crm-data');
  });

  test('a directory source is archived and inferred as a bundle from package.json', async () => {
    mkdirSync(join(tmp, 'site'), { recursive: true });
    writeFileSync(join(tmp, 'site', 'package.json'), '{"name":"site"}\n');
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'deploy', 'site', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    const create = calls.find(
      (c) => c.method === 'POST' && c.path === `/v1/projects/${PROJECT}/apps`,
    );
    expect(create?.body).toEqual({ slug: 'site', name: 'site' });
    const register = calls.find(
      (c) => c.method === 'POST' && c.path === `/v1/projects/${PROJECT}/apps/artifacts`,
    );
    expect(register?.body).toEqual({ kind: 'archive', media_type: 'application/gzip' });
    // The directory went up as a gzip archive, not raw.
    expect(uploaded?.[0]).toBe(0x1f);
    expect(uploaded?.[1]).toBe(0x8b);
    expect(deploymentCall()?.body).toEqual({ artifact_id: 'art-1', source: { kind: 'bundle' } });
    expect(r.stderr).toContain('Uploaded');
    expect(r.stdout).toContain('deployment ready');
  });

  test('a .tar.gz source is uploaded verbatim and typed static', async () => {
    const bytes = new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3, 4]);
    writeFileSync(join(tmp, 'bundle.tar.gz'), bytes);
    const config = writeConfig(startServer());
    const r = await runCli(
      ['apps', 'deploy', 'bundle.tar.gz', '--slug', 'packed', '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(0);
    expect(uploaded ? Array.from(uploaded) : null).toEqual(Array.from(bytes));
    expect(deploymentCall()?.body).toEqual({ artifact_id: 'art-1', source: { kind: 'static' } });
  });

  test('--image without --command and --port is refused before any artifact work', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['apps', 'deploy', '--image', 'registry.example.test/app:7', '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('OCI deployments require --command and --port');
    // The App itself IS provisioned first (current behavior) — but nothing is
    // registered, uploaded, or deployed.
    expect(calls.some((c) => c.path.endsWith('/artifacts'))).toBe(false);
    expect(deploymentCall()).toBeUndefined();
  });

  test('--image registers an OCI artifact and sends the command/port source', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      [
        'apps',
        'deploy',
        '--image',
        'registry.example.test/app:7',
        '--command',
        '["node","server.js"]',
        '--port',
        '8080',
        '--project',
        PROJECT,
      ],
      config,
    );
    expect(r.code).toBe(0);
    const register = calls.find(
      (c) => c.method === 'POST' && c.path === `/v1/projects/${PROJECT}/apps/artifacts`,
    );
    expect(register?.body).toEqual({ kind: 'oci_image', image: 'registry.example.test/app:7' });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(deploymentCall()?.body).toEqual({
      artifact_id: 'art-1',
      source: {
        kind: 'oci_image',
        image: 'registry.example.test/app:7',
        command: ['node', 'server.js'],
        port: 8080,
      },
    });
    expect(r.stdout).toContain('deployment ready');
  });

  test('a Dockerfile directory without --command and --port is refused', async () => {
    mkdirSync(join(tmp, 'container'), { recursive: true });
    writeFileSync(join(tmp, 'container', 'Dockerfile'), 'FROM scratch\n');
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'deploy', 'container', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Dockerfile deployments require --command and --port');
  });

  test('--manifest-app with a kortix.yaml that declares no kortix_version 2 or 3 is refused, never deployed as a static folder', async () => {
    writeFileSync(join(tmp, 'kortix.yaml'), 'apps:\n  db:\n    type: oci_image\n    image: busybox:1.36\n');
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'deploy', '--manifest-app', 'db', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('kortix_version 2 or 3');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  test('a refused release config prints every issue with its path', async () => {
    writeFileSync(
      join(tmp, 'kortix.yaml'),
      'kortix_version: 2\napps:\n  db:\n    type: oci_image\n    image: busybox:1.36\n    command: [sh]\n    http_service:\n      internal_port: 8080\n',
    );
    configIssues = [{ path: 'http_service.internal_port', message: '8080 is reserved by the App supervisor.' }];
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'deploy', '--manifest-app', 'db', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('The release config is invalid');
    expect(r.stderr).toContain('http_service.internal_port: 8080 is reserved by the App supervisor.');
  });

  test('--manifest-app names a missing block loudly', async () => {
    writeFileSync(
      join(tmp, 'kortix.yaml'),
      'kortix_version: 2\napps:\n  storefront:\n    path: web\n    type: static\n',
    );
    const config = writeConfig(startServer());
    const r = await runCli(
      ['apps', 'deploy', '--manifest-app', 'nope', '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('kortix.yaml has no apps.nope block');
  });

  test('the retired --budget flag is ignored with a notice: its value is never read as the path, and nothing sends a budget', async () => {
    appFields = { always_on: true, estimated_monthly_usd: 73.48 };
    mkdirSync(join(tmp, 'site'), { recursive: true });
    writeFileSync(join(tmp, 'site', 'package.json'), '{"name":"site"}\n');
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'deploy', '--budget', '20', 'site', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    const create = calls.find((c) => c.method === 'POST' && c.path === `/v1/projects/${PROJECT}/apps`);
    expect(create?.body).toEqual({ slug: 'site', name: 'site' });
    expect(r.stderr).toContain('--budget is ignored: Apps have no budget');
    expect(r.stdout).toContain('deployment ready');
  });

  test('a static deploy and an always-on App print no budget warning', async () => {
    appFields = { always_on: true, estimated_monthly_usd: 73.48 };
    writeFileSync(join(tmp, 'bundle.tar.gz'), new Uint8Array([0x1f, 0x8b, 8, 0]));
    const config = writeConfig(startServer());
    const staticRun = await runCli(['apps', 'deploy', 'bundle.tar.gz', '--project', PROJECT], config);
    expect(staticRun.code).toBe(0);
    expect(staticRun.stderr).not.toContain('runs 24/7');
    appFields = { always_on: true, estimated_monthly_usd: 73.48 };
    mkdirSync(join(tmp, 'site'), { recursive: true });
    writeFileSync(join(tmp, 'site', 'package.json'), '{"name":"site"}\n');
    const serverRun = await runCli(['apps', 'deploy', 'site', '--project', PROJECT], config);
    expect(serverRun.code).toBe(0);
    expect(serverRun.stderr).not.toContain('runs 24/7');
  });

  test('a server deploy prints the 24/7 run line and no price; a static deploy and an on-demand App do not', async () => {
    appFields = { always_on: true, estimated_monthly_usd: 73.48 };
    writeFileSync(join(tmp, 'bundle.tar.gz'), new Uint8Array([0x1f, 0x8b, 8, 0]));
    mkdirSync(join(tmp, 'site'), { recursive: true });
    writeFileSync(join(tmp, 'site', 'package.json'), '{"name":"site"}\n');
    const config = writeConfig(startServer());
    const server = await runCli(['apps', 'deploy', 'site', '--project', PROJECT], config);
    expect(server.stdout).toContain('Runs 24/7 on 1 vCPU / 2 GB');
    expect(server.stdout).not.toMatch(/\$|USD|month/);
    expect(server.stdout).not.toContain('budget');
    const staticRun = await runCli(['apps', 'deploy', 'bundle.tar.gz', '--project', PROJECT], config);
    expect(staticRun.stdout).not.toContain('Runs 24/7');
    appFields = { always_on: false, estimated_monthly_usd: 73.48 };
    const onDemand = await runCli(['apps', 'deploy', 'site', '--project', PROJECT], config);
    expect(onDemand.stdout).not.toContain('Runs 24/7');
  });

  test('an unknown deploy flag is rejected', async () => {
    mkdirSync(join(tmp, 'site'), { recursive: true });
    writeFileSync(join(tmp, 'site', 'index.html'), 'hello');
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'deploy', 'site', '--bogus', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Unknown deploy option --bogus');
  });
});

describe('loadManifestApps reads kortix_version 3', () => {
  test('a v3 manifest\'s apps blocks seed a deploy', async () => {
    const { loadManifestApps } = await import('../commands/apps-deploy.ts');
    const dir = mkdtempSync(join(tmpdir(), 'apps-v3-'));
    try {
      writeFileSync(join(dir, 'kortix.yaml'), 'kortix_version: 3\ndefault_agent: a\napps:\n  web:\n    path: web\nagents:\n  a: {}\n');
      expect(loadManifestApps(dir)?.blocks).toEqual({ web: { path: 'web' } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
