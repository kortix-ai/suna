import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    monthly_budget_usd: 5,
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
        return Response.json({ apps: [] });
      }
      if (path === `/v1/projects/${PROJECT}/apps` && req.method === 'POST') {
        const input = body as { slug: string; name: string };
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
        return Response.json(deployment());
      }
      if (path === `/v1/projects/${PROJECT}/apps/${APP_ID}` && req.method === 'GET') {
        return Response.json(app());
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
        '    backends: [main]',
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
    expect(create?.body).toEqual({ slug: 'storefront', name: 'storefront', cpu: 2, memory_gb: 4, backends: ['main'] });
    // --output-dir wins over the manifest's output_dir; env and secrets pass through.
    expect(deploymentCall()?.body).toEqual({
      artifact_id: 'art-1',
      source: { kind: 'bundle', output_dir: 'build' },
      environment: { NODE_ENVIRONMENT: 'production' },
      secrets: { DATABASE_URL: 'database-primary' },
    });
    expect(r.stdout).toContain('deployment ready');
    expect(r.stdout).toContain('storefront.kortix.test');
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

  test('--budget sets the new App\'s monthly budget; a server App below its 24/7 estimate is warned on stderr', async () => {
    appFields = { always_on: true, estimated_monthly_usd: 73.48 };
    mkdirSync(join(tmp, 'site'), { recursive: true });
    writeFileSync(join(tmp, 'site', 'package.json'), '{"name":"site"}\n');
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'deploy', 'site', '--budget', '20', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    const create = calls.find((c) => c.method === 'POST' && c.path === `/v1/projects/${PROJECT}/apps`);
    expect(create?.body).toEqual({ slug: 'site', name: 'site', monthly_budget_usd: 20 });
    // The fake server answers with the default $5 budget.
    expect(r.stderr).toContain('runs 24/7, about $73.48/month at list compute rates, but its monthly budget is $5.00');
    expect(r.stdout).toContain('deployment ready');
  });

  test('a static deploy and an App whose budget covers 24/7 are not warned', async () => {
    appFields = { always_on: true, estimated_monthly_usd: 73.48 };
    writeFileSync(join(tmp, 'bundle.tar.gz'), new Uint8Array([0x1f, 0x8b, 8, 0]));
    const config = writeConfig(startServer());
    const staticRun = await runCli(['apps', 'deploy', 'bundle.tar.gz', '--project', PROJECT], config);
    expect(staticRun.code).toBe(0);
    expect(staticRun.stderr).not.toContain('runs 24/7');
    appFields = { always_on: true, estimated_monthly_usd: 73.48, monthly_budget_usd: 100 };
    mkdirSync(join(tmp, 'site'), { recursive: true });
    writeFileSync(join(tmp, 'site', 'package.json'), '{"name":"site"}\n');
    const serverRun = await runCli(['apps', 'deploy', 'site', '--project', PROJECT], config);
    expect(serverRun.code).toBe(0);
    expect(serverRun.stderr).not.toContain('runs 24/7');
  });

  test('a server deploy prints the 24/7 cost line; a static deploy and an on-demand App do not', async () => {
    appFields = { always_on: true, estimated_monthly_usd: 73.48, monthly_budget_usd: 74 };
    writeFileSync(join(tmp, 'bundle.tar.gz'), new Uint8Array([0x1f, 0x8b, 8, 0]));
    mkdirSync(join(tmp, 'site'), { recursive: true });
    writeFileSync(join(tmp, 'site', 'package.json'), '{"name":"site"}\n');
    const config = writeConfig(startServer());
    const server = await runCli(['apps', 'deploy', 'site', '--project', PROJECT], config);
    expect(server.stdout).toContain('Runs 24/7 on 1 vCPU / 2 GB: about $73/month (budget $74)');
    const staticRun = await runCli(['apps', 'deploy', 'bundle.tar.gz', '--project', PROJECT], config);
    expect(staticRun.stdout).not.toContain('Runs 24/7');
    appFields = { always_on: false, estimated_monthly_usd: 73.48 };
    const onDemand = await runCli(['apps', 'deploy', 'site', '--project', PROJECT], config);
    expect(onDemand.stdout).not.toContain('Runs 24/7');
  });

  test('--budget must be a positive number', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['apps', 'deploy', 'site', '--budget', 'lots', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--budget must be positive');
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
