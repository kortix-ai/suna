import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ENTRY = join(resolve(import.meta.dir, '..', '..'), 'src', 'index.ts');
const PROJECT_ID = '00000000-0000-4000-a000-000000000321';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000654';

let root = '';
let server: ReturnType<typeof Bun.serve> | null = null;
let templates: unknown[] = [];
let defaultSlug: string | null = null;
let builds: unknown[] = [];

function template(overrides: Record<string, unknown> = {}) {
  return {
    template_id: 'tpl_1',
    slug: 'web',
    name: 'Web',
    is_default: false,
    source: 'toml',
    provider: 'daytona',
    has_dockerfile: false,
    has_image: true,
    image: 'repo.example.test/web:2',
    dockerfile_path: null,
    entrypoint: null,
    cpu: 2,
    memory_gb: 4,
    disk_gb: 10,
    snapshot_name: 'snap-web',
    content_hash: 'hash-web',
    daytona_state: 'ready',
    provider_state: 'ready',
    ready: true,
    ...overrides,
  };
}

function build(overrides: Record<string, unknown> = {}) {
  return {
    build_id: 'build_1',
    slug: 'web',
    status: 'ready',
    error: null,
    error_category: null,
    source: 'ui',
    started_at: '2026-08-01T10:00:00.000Z',
    finished_at: '2026-08-01T10:05:00.000Z',
    ...overrides,
  };
}

async function runCli(args: string[]) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_CONFIG_FILE: join(root, 'config.json'),
    KORTIX_NO_UPDATE_CHECK: '1',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
  for (const key of ['KORTIX_API_URL', 'KORTIX_TOKEN', 'KORTIX_PROJECT_ID', 'KORTIX_TOKEN']) {
    delete env[key];
  }
  const child = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: root,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-sbx-ls-builds-'));
  mkdirSync(join(root, '.kortix'), { recursive: true });
  templates = [];
  defaultSlug = null;
  builds = [];
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === `/v1/projects/${PROJECT_ID}/sandbox-templates`) {
        return Response.json({ items: templates, default_slug: defaultSlug });
      }
      if (url.pathname === `/v1/projects/${PROJECT_ID}/snapshots`) {
        return Response.json({ builds });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  const apiBase = `http://127.0.0.1:${server.port}`;
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'token-ls-builds-test',
          user_id: 'user-ls-builds-test',
          user_email: 'ls-builds@example.test',
          account_id: ACCOUNT_ID,
          logged_in_at: '2026-08-05T00:00:00.000Z',
        },
      },
    }),
  );
  writeFileSync(
    join(root, '.kortix', 'link.json'),
    JSON.stringify({
      project_id: PROJECT_ID,
      account_id: ACCOUNT_ID,
      host: 'test',
      host_url: apiBase,
      linked_at: '2026-08-05T00:00:00.000Z',
    }),
  );
});

afterEach(() => {
  server?.stop(true);
  server = null;
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('kortix sandboxes ls and builds (characterization)', () => {
  test('ls pins the template table: default marker, spec column, resources, footer', async () => {
    templates = [
      template(),
      template({
        template_id: 'tpl_2',
        slug: 'tools',
        name: 'Tools',
        source: 'ui',
        has_image: false,
        image: null,
        has_dockerfile: true,
        dockerfile_path: 'sandbox/tools.Dockerfile',
        daytona_state: 'error',
        provider_state: 'error',
        ready: false,
        cpu: 1,
        memory_gb: 2,
        disk_gb: 5,
      }),
    ];
    defaultSlug = 'web';

    const result = await runCli(['sandboxes', 'ls']);

    expect(result.code).toBe(0);
    // The default template carries the ● marker.
    expect(result.stdout).toContain('● web');
    expect(result.stdout).toMatch(/● web\s+ready\s+toml\s+repo\.example\.test\/web:2\s+2cpu\/4g\/10g/);
    expect(result.stdout).toMatch(/tools\s+error\s+ui\s+sandbox\/tools\.Dockerfile\s+1cpu\/2g\/5g/);
    expect(result.stdout).toContain('2 templates · default: web');

    const json = await runCli(['sandboxes', 'ls', '--json']);
    expect(json.code).toBe(0);
    const payload = JSON.parse(json.stdout) as { default_slug: string; items: unknown[] };
    expect(payload.default_slug).toBe('web');
    expect(payload.items).toHaveLength(2);
  });

  test('builds pins the build table: status, first failure line, category, footer', async () => {
    builds = [
      build(),
      build({
        build_id: 'build_2',
        slug: 'tools',
        status: 'failed',
        error: 'docker build exited 1\nStep 4/9 RUN pnpm build failed',
        error_category: 'provider',
        source: 'toml',
        started_at: '2026-08-02T11:30:00.000Z',
        finished_at: null,
      }),
    ];

    const result = await runCli(['sandboxes', 'builds']);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/web\s+ready\s+ui\s+2026-08-01 10:00:00/);
    expect(result.stdout).toMatch(/tools\s+failed\s+toml\s+2026-08-02 11:30:00/);
    // Only the FIRST line of a failed build's error is shown, plus its category.
    expect(result.stdout).toContain('docker build exited 1');
    expect(result.stdout).not.toContain('Step 4/9');
    expect(result.stdout).toContain('[provider]');
    expect(result.stdout).toContain('2 builds');
  });

  test('builds with nothing built yet says so', async () => {
    const result = await runCli(['sandboxes', 'builds']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No builds yet.');
    expect(result.stdout).not.toContain('0 build');
  });
});
