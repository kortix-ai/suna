import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '../index.ts');
let cwd: string;
let server: ReturnType<typeof Bun.serve>;
let hits: Array<{ path: string; auth: string | null }>;
let configFile: string;
let bareRepo: string;
let provisionBodies: unknown[];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'kortix-ship-host-'));
  mkdirSync(join(cwd, '.kortix'));
  writeFileSync(join(cwd, 'kortix.yaml'), 'name: synthetic-workspace\n');
  Bun.spawnSync(['git', 'init', '-b', 'main'], { cwd });
  hits = [];
  provisionBodies = [];
  bareRepo = join(cwd, 'remote.git');
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      hits.push({ path, auth: req.headers.get('authorization') });
      if (path === '/v1/accounts/me') return Response.json({ accounts: [] });
      if (path === '/v1/projects/provision') {
        provisionBodies.push(await req.json());
        return Response.json({
          project_id: 'created_workspace',
          account_id: 'account_workspace',
          name: 'Workspace',
          repo_url: bareRepo,
          push_token: 'synthetic_push_token',
          metadata: {},
        });
      }
      if (path.endsWith('/connectors/sync')) return Response.json({ ok: true });
      if (path.startsWith('/v1/projects/'))
        return Response.json({
          project_id: path.split('/').at(-1),
          account_id: 'account_workspace',
          name: 'Workspace',
          repo_url: 'https://git.example.test/workspace.git',
          default_branch: 'main',
          metadata: {},
        });
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    },
  });
  const host = {
    url: `http://127.0.0.1:${server.port}`,
    token: 'tok_workspace',
    user_id: 'user_synthetic',
    user_email: 'agent@example.test',
    account_id: 'account_workspace',
    logged_in_at: '2026-01-01T00:00:00Z',
    default_project: {
      project_id: 'global_default',
      account_id: 'account_workspace',
      name: 'Default',
    },
  };
  configFile = join(cwd, 'config.json');
  writeFileSync(
    configFile,
    JSON.stringify({
      active: 'workspace',
      hosts: { workspace: host, other: { ...host, token: 'tok_other' } },
    }),
  );
});
afterEach(() => {
  server.stop(true);
  rmSync(cwd, { recursive: true, force: true });
});

async function cli(args: string[]) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_CONFIG_FILE: configFile,
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_NO_UPDATE_CHECK: '1',
    KORTIX_TOKEN: 'tok_session',
    KORTIX_CLI_TOKEN: 'tok_session',
    KORTIX_PROJECT_ID: 'session_project',
    KORTIX_API_URL: 'http://127.0.0.1:9',
    NO_COLOR: '1',
    HOME: cwd,
  };
  delete env.BASH_ENV;
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill(), 10_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timer));
  return { code, stdout, stderr };
}
function link(host = 'workspace') {
  writeFileSync(
    join(cwd, '.kortix/link.json'),
    JSON.stringify({ project_id: 'workspace_project', account_id: 'account_workspace', host }),
  );
}
const ship = [
  'ship',
  '--dry-run',
  '--no-verify',
  '--no-env',
  '--no-connect',
  '--origin',
  'managed',
  '-y',
];

test('ship --host syncs the workspace link, not the injected session project', async () => {
  link();
  const result = await cli([...ship, '--host', 'workspace']);
  expect(result.code).toBe(0);
  expect(hits).toEqual([{ path: '/v1/projects/workspace_project', auth: 'Bearer tok_workspace' }]);
  expect(result.stdout).toContain('sync');
});
test('ship without --host uses the linked stored credential, not session auth', async () => {
  link('other');
  expect((await cli(ship)).code).toBe(0);
  expect(hits).toEqual([{ path: '/v1/projects/workspace_project', auth: 'Bearer tok_other' }]);
});
test('first ship ignores session and global defaults and uses the configured account', async () => {
  const result = await cli(ship);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('new project');
  expect(hits).toEqual([{ path: '/v1/accounts/me', auth: 'Bearer tok_workspace' }]);
});
test('explicit project and host override both workspace and session', async () => {
  link();
  expect((await cli([...ship, '--project', 'explicit_project', '--host', 'other'])).code).toBe(0);
  expect(hits).toEqual([{ path: '/v1/projects/explicit_project', auth: 'Bearer tok_other' }]);
});
test('ship refuses a foreign workspace link before any request unless a project is explicit', async () => {
  link();
  const result = await cli([...ship, '--host', 'other']);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('--project');
  expect(hits).toEqual([]);
});
test('ship does not fall back to session auth for an unknown host', async () => {
  const result = await cli([...ship, '--host', 'missing']);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('not logged in');
  expect(hits).toEqual([]);
});
test.each([
  { args: ['workspace_project', '--host', 'other'] },
  { args: ['--host=other', 'workspace_project'] },
])('projects link accepts host placement %j', async ({ args }) => {
  const result = await cli(['projects', 'link', ...args]);
  expect(result.code).toBe(0);
  expect(hits).toEqual([{ path: '/v1/projects/workspace_project', auth: 'Bearer tok_other' }]);
  expect(JSON.parse(readFileSync(join(cwd, '.kortix/link.json'), 'utf8'))).toMatchObject({
    project_id: 'workspace_project',
    host: 'other',
    host_url: `http://127.0.0.1:${server.port}`,
  });
});
test('first ship provisions on the named host and pushes the actual commit to local Git', async () => {
  expect(Bun.spawnSync(['git', 'init', '--bare', bareRepo]).exitCode).toBe(0);
  expect(Bun.spawnSync(['git', 'config', 'user.name', 'Synthetic Agent'], { cwd }).exitCode).toBe(
    0,
  );
  expect(
    Bun.spawnSync(['git', 'config', 'user.email', 'synthetic@example.test'], { cwd }).exitCode,
  ).toBe(0);
  const result = await cli([
    'ship',
    '--host',
    'other',
    '--name',
    'synthetic-workspace',
    '--no-verify',
    '--no-env',
    '--no-connect',
    '--origin',
    'managed',
    '-y',
  ]);
  expect(result.code).toBe(0);
  expect(provisionBodies).toEqual([
    { name: 'synthetic-workspace', account_id: 'account_workspace', seed_starter: false },
  ]);
  expect(hits.every((hit) => hit.auth === 'Bearer tok_other')).toBe(true);
  expect(hits.map((hit) => hit.path)).toEqual([
    '/v1/accounts/me',
    '/v1/projects/provision',
    '/v1/connectors/projects/created_workspace/connectors/sync',
  ]);
  const pushed = Bun.spawnSync(['git', '--git-dir', bareRepo, 'show', 'main:kortix.yaml']);
  expect(pushed.exitCode).toBe(0);
  expect(pushed.stdout.toString()).toBe('name: synthetic-workspace\n');
  expect(JSON.parse(readFileSync(join(cwd, '.kortix/link.json'), 'utf8'))).toMatchObject({
    project_id: 'created_workspace',
    host: 'other',
  });
});

test('projects use binds only the named host despite session injection', async () => {
  expect((await cli(['projects', 'use', 'workspace_project', '--host', 'other'])).code).toBe(0);
  expect(hits).toEqual([{ path: '/v1/projects/workspace_project', auth: 'Bearer tok_other' }]);
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  expect(config.hosts.other.default_project.project_id).toBe('workspace_project');
  expect(config.hosts.workspace.default_project.project_id).toBe('global_default');
});
