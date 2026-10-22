import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// KRTX-2825: inside a sandbox, the project-member form of `access grant` acted
// on the project the CLI config names (a `.kortix/link.json`, or the selected
// host's default), while the assignment form (`--user`) took the injected
// KORTIX_PROJECT_ID first and paired it with the config host's credential:
// "Not found". Both forms must resolve the same project with the same
// credential.

const CLI_ENTRY = join(resolve(import.meta.dir, '..', '..'), 'src', 'index.ts');
const STORED_PROJECT = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';

let tmp: string;
let envApi: ReturnType<typeof Bun.serve> | null = null;
let storedApi: ReturnType<typeof Bun.serve> | null = null;
let envRequests: string[] = [];
let storedRequests: Array<{ method: string; path: string; body: unknown }> = [];

/** The sandbox's own deployment: it knows nothing about the stored project. */
function startEnvApi() {
  return Bun.serve({
    port: 0,
    fetch(req) {
      envRequests.push(`${req.method} ${new URL(req.url).pathname}`);
      return Response.json({ error: 'Not found' }, { status: 404 });
    },
  });
}

/** The user's own stored host, which owns the stored project. */
function startStoredApi() {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = req.method === 'GET' ? undefined : await req.json().catch(() => undefined);
      storedRequests.push({ method: req.method, path, body });
      if (path === `/v1/projects/${STORED_PROJECT}`) {
        return Response.json({ project_id: STORED_PROJECT, account_id: 'acct_own', name: 'own' });
      }
      if (path.endsWith('/iam/roles')) {
        return Response.json({
          roles: [{ role_id: 'builtin:manager', key: 'manager', name: 'Manager', resource_type: 'project', is_system: true, account_id: null }],
        });
      }
      if (path.endsWith('/iam/assignments') && req.method === 'POST') {
        return Response.json({ assignment_id: 'a_new', principal_type: 'user', principal_id: MEMBER, role_key: 'manager', scope_type: 'project', scope_id: STORED_PROJECT });
      }
      if (path.includes(`/projects/${STORED_PROJECT}/access/`)) return Response.json({ ok: true });
      return Response.json({ error: `unexpected ${req.method} ${path}` }, { status: 404 });
    },
  });
}

function seedConfig(): void {
  writeFileSync(
    join(tmp, 'config.json'),
    JSON.stringify({
      active: 'self',
      hosts: {
        self: {
          url: `http://127.0.0.1:${storedApi!.port}`,
          token: 'kortix_pat_own',
          user_id: 'user_own',
          user_email: 'owner@example.test',
          account_id: 'acct_own',
          logged_in_at: '2026-01-01T00:00:00.000Z',
          default_project: { project_id: STORED_PROJECT, account_id: 'acct_own', name: 'own' },
        },
      },
    }),
  );
}

function sandboxEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: tmp,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    KORTIX_NO_UPDATE_CHECK: '1',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_CONFIG_FILE: join(tmp, 'config.json'),
    KORTIX_API_URL: `http://127.0.0.1:${envApi!.port}`,
    KORTIX_TOKEN: 'kortix_pat_session',
    KORTIX_PROJECT_ID: 'proj_session',
  };
}

async function runCli(args: string[]) {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: tmp,
    env: sandboxEnv(),
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

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kortix-access-host-scope-'));
  envRequests = [];
  storedRequests = [];
  envApi = startEnvApi();
  storedApi = startStoredApi();
  seedConfig();
});

afterEach(() => {
  envApi?.stop(true);
  storedApi?.stop(true);
  rmSync(tmp, { recursive: true, force: true });
});

async function selectStoredHost(): Promise<void> {
  const use = await runCli(['hosts', 'use', 'self']);
  expect(use.code).toBe(0);
  envRequests = [];
  storedRequests = [];
}

/** The working directory is linked to the stored host's project. */
function linkStoredProject(): void {
  mkdirSync(join(tmp, '.kortix'), { recursive: true });
  writeFileSync(
    join(tmp, '.kortix', 'link.json'),
    JSON.stringify({ project_id: STORED_PROJECT, account_id: 'acct_own', host: 'self', linked_at: '2026-01-01T00:00:00.000Z' }),
  );
}

function expectAssignmentOnStoredProject(): void {
  const post = storedRequests.find((q) => q.method === 'POST' && q.path.endsWith('/iam/assignments'));
  expect(post?.body).toMatchObject({ principal_type: 'user', principal_id: MEMBER, scope_type: 'project', scope_id: STORED_PROJECT });
  expect(envRequests).toEqual([]);
}

test('selected host: the project-member form grants on its default project', async () => {
  await selectStoredHost();
  const r = await runCli(['access', 'grant', MEMBER, '--role', 'manager']);
  expect(r.code).toBe(0);
  expect(storedRequests.some((q) => q.method === 'PUT' && q.path.includes(`/projects/${STORED_PROJECT}/access/${MEMBER}`))).toBe(true);
  expect(envRequests).toEqual([]);
});

test('selected host: the assignment form (--user) grants on the same project', async () => {
  await selectStoredHost();
  const r = await runCli(['access', 'grant', '--user', MEMBER, '--role', 'manager']);
  expect(r.code).toBe(0);
  expectAssignmentOnStoredProject();
});

test('linked directory: the project-member form grants on the linked project', async () => {
  linkStoredProject();
  const r = await runCli(['access', 'grant', MEMBER, '--role', 'manager']);
  expect(r.code).toBe(0);
  expect(storedRequests.some((q) => q.method === 'PUT' && q.path.includes(`/projects/${STORED_PROJECT}/access/${MEMBER}`))).toBe(true);
  expect(envRequests).toEqual([]);
});

test('linked directory: the assignment form (--user) grants on the linked project, not the injected one', async () => {
  linkStoredProject();
  const r = await runCli(['access', 'grant', '--user', MEMBER, '--role', 'manager']);
  expect(r.stderr).not.toContain('Not found');
  expect(r.code).toBe(0);
  expectAssignmentOnStoredProject();
});
