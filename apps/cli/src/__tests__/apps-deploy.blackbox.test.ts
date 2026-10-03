import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runApps } from '../commands/apps.ts';

// Characterization for `kortix apps deploy` — the flag/manifest merge
// precedence and the source staging rules (directory vs .tar.gz vs --image,
// and the --command/--port requirement), driven against a scripted API before
// the command's orchestration moved into apps-deploy.ts. deployCommand had
// zero coverage before this file.

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_STDOUT_WRITE = process.stdout.write;
const ORIGINAL_STDERR_WRITE = process.stderr.write;

const ENV_KEYS = [
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_DISABLE_SANDBOX_ENV_FILE',
  'KORTIX_CONFIG_FILE',
  'KORTIX_AUTH_FILE',
] as const;

let saved: Record<string, string | undefined>;
let tmp: string;
let originalCwd: string;
let stdout = '';
let stderr = '';
let calls: Array<{ method: string; path: string; body?: unknown }> = [];

interface DeployBody {
  artifact_id: string;
  source: Record<string, unknown>;
  environment?: Record<string, string>;
  secrets?: string[];
}

let deploymentBodies: DeployBody[] = [];
/** The manifest block the test's kortix.yaml carries (null = no manifest). */
let manifestApps: Record<string, Record<string, unknown>> | null = null;

function writeConfig(): void {
  const file = join(tmp, 'config.json');
  writeFileSync(
    file,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: 'https://api.test',
          token: 'tok_test',
          user_id: 'user_1',
          user_email: 'user@example.test',
          account_id: 'account_1',
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
    'utf8',
  );
  process.env.KORTIX_CONFIG_FILE = file;
}

const APP = {
  app_id: 'app_1',
  project_id: 'proj_apps',
  slug: 'demo',
  name: 'demo',
  status: 'ready',
  url: 'https://demo.apps.example.test',
  access_mode: 'project',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};
const DEPLOYMENT = {
  deployment_id: 'dep_1',
  app_id: 'app_1',
  status: 'ready',
  created_at: '2026-01-01T00:00:00.000Z',
};

function mockApi(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    let body: unknown;
    if (init?.body && typeof init.body === 'string' && init.body !== '') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = undefined;
      }
    }
    if (method !== 'PUT') calls.push({ method, path, body });
    if (path === '/v1/projects/proj_apps' && method === 'GET') {
      // context() pre-checks the Apps feature flag on the project.
      return Response.json({
        project_id: 'proj_apps',
        name: 'Deploy Demo',
        status: 'active',
        experimental: { apps: true },
      });
    }
    if (path === '/v1/projects/proj_apps/apps' && method === 'GET') {
      return Response.json({ apps: [] });
    }
    if (path === '/v1/projects/proj_apps/apps/app_1' && method === 'GET') {
      return Response.json(APP);
    }
    if (path === '/v1/projects/proj_apps/apps' && method === 'POST') {
      return Response.json(APP);
    }
    if (path === '/v1/projects/proj_apps/apps/artifacts' && method === 'POST') {
      return Response.json({
        artifact: { artifact_id: 'art_1', kind: 'archive', created_at: '2026-01-01T00:00:00.000Z' },
        upload: { url: 'https://storage.test/upload', max_bytes: 100_000_000 },
      });
    }
    if (path === '/v1/projects/proj_apps/apps/artifacts/art_1/finalize' && method === 'POST') {
      return Response.json({
        artifact: { artifact_id: 'art_1', kind: 'archive', created_at: '2026-01-01T00:00:00.000Z' },
      });
    }
    if (path.includes('/artifacts/art_1/finalize') && method === 'POST') {
      return Response.json({
        artifact: { artifact_id: 'art_1', kind: 'archive', created_at: '2026-01-01T00:00:00.000Z' },
      });
    }
    if (path.endsWith('/deployments') && method === 'POST') {
      deploymentBodies.push(body as DeployBody);
      return Response.json(DEPLOYMENT);
    }
    // `--no-wait` is off by default: the command polls the deployment until it
    // settles, and the mock answers settled on the first poll.
    if (path === '/v1/projects/proj_apps/apps/app_1/deployments/dep_1' && method === 'GET') {
      return Response.json({ deployment: DEPLOYMENT });
    }
    if (url.host === 'storage.test') {
      return new Response(null, { status: 200 });
    }
    return Response.json({ error: 'no route' }, { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  tmp = mkdtempSync(join(tmpdir(), 'kortix-apps-deploy-'));
  originalCwd = process.cwd();
  process.chdir(tmp);
  process.env.KORTIX_PROJECT_ID = 'proj_apps';
  writeConfig();
  stdout = '';
  stderr = '';
  calls = [];
  deploymentBodies = [];
  manifestApps = null;
  const stdoutStream = process.stdout as unknown as { write: (chunk: unknown) => boolean };
  const stderrStream = process.stderr as unknown as { write: (chunk: unknown) => boolean };
  stdoutStream.write = (chunk: unknown) => ((stdout += String(chunk)), true);
  stderrStream.write = (chunk: unknown) => ((stderr += String(chunk)), true);
  mockApi();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  const stdoutStream = process.stdout as unknown as { write: (chunk: unknown) => boolean };
  const stderrStream = process.stderr as unknown as { write: (chunk: unknown) => boolean };
  stdoutStream.write = ORIGINAL_STDOUT_WRITE as unknown as (chunk: unknown) => boolean;
  stderrStream.write = ORIGINAL_STDERR_WRITE as unknown as (chunk: unknown) => boolean;
  process.chdir(originalCwd);
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(tmp, { recursive: true, force: true });
});

function writeManifest(): void {
  const block = manifestApps ?? {};
  const apps = Object.entries(block)
    .map(([name, spec]) => `  ${name}:\n${JSON.stringify(spec, null, 2).replace(/^/gm, '    ')}`)
    .join('\n');
  writeFileSync(
    join(tmp, 'kortix.yaml'),
    `kortix_version: 2\nproject:\n  name: Deploy Demo\nagents: []\napps:\n${apps}\n`,
    'utf8',
  );
}

describe('kortix apps deploy — merge precedence and source staging', () => {
  test('the manifest block fills what the flags omit; a flag wins', async () => {
    manifestApps = {
      site: { type: 'bundle', output_dir: 'dist', install_command: 'pnpm i', env: { FOO: 'bar' } },
      worker: { type: 'dockerfile', port: 8080, command: './serve' },
    };
    writeManifest();
    mkdirSync(join(tmp, 'site', 'dist'), { recursive: true });
    writeFileSync(join(tmp, 'site', 'dist', 'index.js'), 'hi', 'utf8');
    mkdirSync(join(tmp, 'worker'), { recursive: true });
    writeFileSync(join(tmp, 'worker', 'Dockerfile'), 'FROM ubuntu\n', 'utf8');

    const code = await runApps(['deploy', 'site', '--manifest-app', 'site']);
    expect(code).toBe(0);
    const body = deploymentBodies[0]!;
    // Manifest-provided: the bundle kind, its output dir and install command,
    // and the block's env.
    expect(body.source).toMatchObject({ kind: 'bundle', output_dir: 'dist', install_command: 'pnpm i' });
    expect(body.environment).toEqual({ FOO: 'bar' });

    calls = [];
    deploymentBodies = [];
    const withFlag = await runApps(['deploy', 'site', '--manifest-app', 'site', '--output-dir', 'other']);
    expect(withFlag).toBe(0);
    // The explicit flag overrides the manifest value; the manifest still
    // fills the rest.
    expect(deploymentBodies[0]!.source).toMatchObject({ kind: 'bundle', output_dir: 'other', install_command: 'pnpm i' });

    calls = [];
    deploymentBodies = [];
    const dockerfile = await runApps(['deploy', 'worker', '--manifest-app', 'worker', '--command', './serve', '--port', '9090']);
    expect(dockerfile).toBe(0);
    // The manifest's port is overridden by the flag; the manifest type wins
    // over the path inference.
    expect(deploymentBodies[0]!.source).toMatchObject({ kind: 'dockerfile', port: 9090, command: ['./serve'] });
  });

  test('an OCI image deploys with --command and --port, and refuses without them', async () => {
    const ok = await runApps([
      'deploy',
      '--image',
      'registry.io/demo:1',
      '--command',
      './serve',
      '--port',
      '3000',
    ]);
    expect(ok).toBe(0);
    // --command parses to an argv array on the wire.
    expect(deploymentBodies[0]!.source).toEqual({
      kind: 'oci_image',
      image: 'registry.io/demo:1',
      command: ['./serve'],
      port: 3000,
    });

    stderr = '';
    const missing = await runApps(['deploy', '--image', 'registry.io/demo:1', '--port', '3000']);
    expect(missing).toBe(1);
    expect(stderr).toContain('OCI deployments require --command and --port');
  });

  test('a source path and --image are mutually exclusive', async () => {
    mkdirSync(join(tmp, 'site'), { recursive: true });
    const code = await runApps(['deploy', 'site', '--image', 'registry.io/demo:1', '--command', './s', '--port', '1']);
    expect(code).toBe(1);
    expect(stderr).toContain('Use a source path or --image, not both');
  });

  test('a missing source path is refused before any API call', async () => {
    const code = await runApps(['deploy', 'no-such-dir']);
    expect(code).toBe(1);
    expect(stderr).toContain('Source path does not exist');
    expect(calls.filter((c) => c.path.endsWith('/apps'))).toHaveLength(0);
  });

  test('a plain file that is not an archive is refused', async () => {
    writeFileSync(join(tmp, 'readme.txt'), 'x', 'utf8');
    const code = await runApps(['deploy', 'readme.txt']);
    expect(code).toBe(1);
    expect(stderr).toContain('Source must be a directory, .tar.gz, or .tgz archive');
  });
});
