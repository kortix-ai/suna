import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Black-box reproduction of the dogfood report: `kortix projects info <id>
// --json` omitted the project id from its JSON payload. The API names the id
// `project_id` on the wire (`serializeProject` has no `id`), and the command
// passed the row through verbatim — so a script reading `.id` got `null` even
// though the id was the command's own argument.
//
// This test spawns the real CLI process against a fixture API that serves the
// exact `serializeProject` wire shape, and reads the payload the way the
// journey did.

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');

const PROJECT_ID = 'c1c10c0a-0000-4000-8000-000000000001';
const ACCOUNT_ID = '5a1e0c0c-0000-4000-8000-00000000000c';
const HOST_NAME = 'remote';
const HOST_TOKEN = 'kortix_pat_host_key';

/** The exact top-level shape `serializeProject` serves on the wire
 *  (apps/api/src/projects/lib/serializers.ts): `project_id`, no `id`. */
function projectRow() {
  return {
    project_id: PROJECT_ID,
    account_id: ACCOUNT_ID,
    name: 'Dogfood Project',
    repo_url: 'https://git.example.test/org/dogfood-project.git',
    git_origin_url: 'https://git.kortix.dev/p/dogfood-project',
    default_branch: 'main',
    manifest_path: 'kortix.yaml',
    status: 'active',
    metadata: {},
    icon: null,
    icon_glyph: null,
    last_opened_at: '2026-10-06T00:00:00.000Z',
    created_at: '2026-10-06T00:00:00.000Z',
    updated_at: '2026-10-06T00:00:00.000Z',
    project_role: 'owner',
    effective_project_role: 'owner',
    dashboard_url: 'https://kortix.com/projects/dogfood',
    experimental: {},
    experimental_features: [],
    default_sandbox_provider: null,
    available_sandbox_providers: ['daytona'],
  };
}

let tmp: string;
let apiBase = '';
let server: ReturnType<typeof Bun.serve> | null = null;

function startApi() {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === `/v1/projects/${PROJECT_ID}`) {
        if (req.headers.get('authorization') === `Bearer ${HOST_TOKEN}`) {
          return Response.json(projectRow());
        }
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
}

function seedWorkspace(): void {
  writeFileSync(
    join(tmp, 'config.json'),
    JSON.stringify({
      active: HOST_NAME,
      hosts: {
        [HOST_NAME]: {
          url: apiBase,
          token: HOST_TOKEN,
          user_id: 'user_1',
          user_email: 'user@example.test',
          account_id: ACCOUNT_ID,
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
  );
}

async function runCli(args: string[], envProjectId?: string) {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: tmp,
    env: {
      ...process.env,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      KORTIX_NO_UPDATE_CHECK: '1',
      KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
      KORTIX_CONFIG_FILE: join(tmp, 'config.json'),
      KORTIX_API_URL: apiBase,
      KORTIX_TOKEN: HOST_TOKEN,
      ...(envProjectId ? { KORTIX_PROJECT_ID: envProjectId } : {}),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), 30_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kortix-projects-info-'));
  server = startApi();
  apiBase = `http://127.0.0.1:${server.port}`;
  seedWorkspace();
});

afterEach(() => {
  server?.stop(true);
  server = null;
  rmSync(tmp, { recursive: true, force: true });
});

test('projects info <id> --json carries the project id (the journey invocation)', async () => {
  const { code, stdout, stderr } = await runCli(['projects', 'info', PROJECT_ID, '--json']);
  expect(stderr).toBe('');
  expect(code).toBe(0);
  const payload = JSON.parse(stdout);
  expect(payload.id).toBe(PROJECT_ID);
  // The wire shape stays: `project_id` keeps its value for existing readers.
  expect(payload.project_id).toBe(PROJECT_ID);
  expect(payload.name).toBe('Dogfood Project');
});

test('projects info --json with the default project carries the id too', async () => {
  const { code, stdout } = await runCli(['projects', 'info', '--json'], PROJECT_ID);
  expect(code).toBe(0);
  const payload = JSON.parse(stdout);
  expect(payload.id).toBe(PROJECT_ID);
  expect(payload.project_id).toBe(PROJECT_ID);
});

test('human output is unchanged (no id key injected into the table)', async () => {
  const { code, stdout } = await runCli(['projects', 'info', PROJECT_ID]);
  expect(code).toBe(0);
  expect(stdout).toContain(PROJECT_ID);
  expect(stdout).toContain('project_id');
  expect(stdout).not.toMatch(/^\s*id\s/);
  expect(stdout.trim().startsWith('{')).toBe(false);
});
