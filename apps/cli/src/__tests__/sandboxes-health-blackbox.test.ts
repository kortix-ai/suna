import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ENTRY = join(resolve(import.meta.dir, '..', '..'), 'src', 'index.ts');
const PROJECT_ID = '00000000-0000-4000-a000-000000000321';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000654';

let root = '';
let server: ReturnType<typeof Bun.serve> | null = null;
let healthBody: Record<string, unknown> = {};

function failure(error: string) {
  return {
    build_id: 'build-old',
    slug: 'default',
    status: 'failed',
    error,
    error_category: 'provider',
    source: 'e2b',
    started_at: '2026-01-01T00:00:00.000Z',
    finished_at: '2026-01-01T00:01:00.000Z',
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
  root = mkdtempSync(join(tmpdir(), 'kortix-sandbox-health-cli-'));
  mkdirSync(join(root, '.kortix'), { recursive: true });
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === `/v1/projects/${PROJECT_ID}/sandbox-health`) {
        return Response.json(healthBody);
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
          token: 'token-health-test',
          user_id: 'user-health-test',
          user_email: 'health@example.test',
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

describe('kortix sandboxes health black box', () => {
  test('a stale provider failure does not override current ready state', async () => {
    const staleFailure = failure('old E2B snapshot is missing');
    healthBody = {
      primary_slug: 'default',
      ready: true,
      building: false,
      latest_failure: staleFailure,
      status: {
        state: 'ready',
        current_failure: null,
        stale_failure: staleFailure,
      },
    };

    const result = await runCli(['sandboxes', 'health']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('primary default  ready');
    expect(result.stdout).not.toContain('old E2B snapshot is missing');
    expect(result.stdout).not.toContain('sandboxes fix');
    expect(result.stderr).toContain('host test (http://127.0.0.1:');
    expect(result.stderr).toContain('health@example.test');
  });

  test('a current blocked failure includes the repair command', async () => {
    const currentFailure = failure('current Daytona build failed');
    healthBody = {
      primary_slug: 'default',
      ready: false,
      building: false,
      latest_failure: currentFailure,
      status: {
        state: 'blocked',
        current_failure: currentFailure,
        stale_failure: null,
      },
    };

    const result = await runCli(['sandboxes', 'health']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('primary default  blocked');
    expect(result.stdout).toContain('current failure: current Daytona build failed');
    expect(result.stdout).toContain('kortix sandboxes fix');
  });
});
