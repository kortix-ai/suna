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
let refuseCreation: boolean;
let useLocalRepo: boolean;
let managedRepo: boolean;
let onboardingBodies: unknown[];
let refuseOnboarding: boolean;
let refuseCredential: boolean;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'kortix-ship-host-'));
  mkdirSync(join(cwd, '.kortix'));
  writeFileSync(join(cwd, 'kortix.yaml'), 'name: synthetic-workspace\n');
  Bun.spawnSync(['git', 'init', '-b', 'main'], { cwd });
  hits = [];
  provisionBodies = [];
  refuseCreation = false;
  useLocalRepo = false;
  managedRepo = false;
  onboardingBodies = [];
  refuseOnboarding = false;
  refuseCredential = false;
  bareRepo = join(cwd, 'remote.git');
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      hits.push({ path, auth: req.headers.get('authorization') });
      if (path === '/v1/accounts/me') return Response.json({ accounts: [] });
      if (path === '/v1/projects/provision') {
        provisionBodies.push(await req.json());
        if (refuseCreation) return Response.json({ error: 'Free accounts are limited to 1 project.' }, { status: 403 });
        return Response.json({
          project_id: 'created_workspace',
          account_id: 'account_workspace',
          name: 'Workspace',
          repo_url: bareRepo,
          push_token: refuseCredential ? undefined : 'synthetic_push_token',
          metadata: { git: { managed: true } },
        });
      }
      if (path.endsWith('/onboarding')) {
        expect(req.method).toBe('PATCH');
        onboardingBodies.push(await req.json());
        return Response.json({}, { status: refuseOnboarding ? 403 : 200 });
      }
      if (path.endsWith('/git-token')) return refuseCredential
        ? Response.json({ error: 'credential refused' }, { status: 403 })
        : Response.json({ push_token: 'synthetic', repo_url: bareRepo });
      if (path.endsWith('/connectors/sync')) return Response.json({ ok: true });
      if (path.startsWith('/v1/projects/'))
        return Response.json({
          project_id: path.split('/').at(-1),
          account_id: 'account_workspace',
          name: 'Workspace',
          repo_url: useLocalRepo ? bareRepo : 'https://git.example.test/workspace.git',
          default_branch: 'main',
          metadata: managedRepo ? { git: { managed: true } } : {},
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
      hosts: { workspace: host, other: { ...host, token: 'tok_other', default_project: { ...host.default_project, project_id: 'other_default' } } },
    }),
  );
});
afterEach(() => {
  server.stop(true);
  rmSync(cwd, { recursive: true, force: true });
});

async function cli(args: string[], extraEnv: Record<string, string> = {}) {
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
    ...extraEnv,
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
test('unlinked ship uses the saved host default instead of creating or using the session project', async () => {
  const result = await cli(ship);
  expect(result.code).toBe(0);
  expect(hits).toEqual([{ path: '/v1/projects/global_default', auth: 'Bearer tok_workspace' }]);
  expect(result.stdout).toContain('global_default');
  expect(result.stdout).toContain('sync');
});

test('unlinked ship targets the named host default, not the active host default', async () => {
  const result = await cli([...ship, '--host', 'other']);
  expect(result.code).toBe(0);
  expect(hits).toEqual([{ path: '/v1/projects/other_default', auth: 'Bearer tok_other' }]);
});

test('unlinked ship honors explicit project before the saved default', async () => {
  const result = await cli([...ship, '--project', 'explicit_project']);
  expect(result.code).toBe(0);
  expect(hits).toEqual([{ path: '/v1/projects/explicit_project', auth: 'Bearer tok_workspace' }]);
});

function clearDefaults() {
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  for (const host of Object.values(config.hosts)) {
    if (typeof host === 'object' && host !== null) Reflect.deleteProperty(host, 'default_project');
  }
  writeFileSync(configFile, JSON.stringify(config));
}

test('first ship without a saved default ignores session project and uses the configured account', async () => {
  clearDefaults();
  const result = await cli(ship);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('new project');
  expect(hits).toEqual([{ path: '/v1/accounts/me', auth: 'Bearer tok_workspace' }]);
});
test('refused creation names the existing-project link recovery command', async () => {
  clearDefaults();
  refuseCreation = true;
  const result = await cli(['ship', '--no-verify', '--no-env', '--no-connect', '--origin', 'managed', '-y']);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('HTTP 403');
  expect(result.stderr).toContain('kortix projects link <project_id>');
  expect(provisionBodies).toHaveLength(1);
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
test.each([false, true])('projects use then ship pushes twice without provisioning (managed=%s)', async (managed) => {
  useLocalRepo = true;
  managedRepo = managed;
  expect(Bun.spawnSync(['git', 'init', '--bare', bareRepo]).exitCode).toBe(0);
  Bun.spawnSync(['git', 'config', 'user.name', 'Synthetic Agent'], { cwd });
  Bun.spawnSync(['git', 'config', 'user.email', 'synthetic@example.test'], { cwd });
  expect((await cli(['projects', 'use', 'chosen_project', '--host', 'workspace'])).code).toBe(0);
  const args = ['ship', '--no-verify', '--no-env', '--no-connect', '-y'];
  expect((await cli(args)).code).toBe(0);
  writeFileSync(join(cwd, 'README.md'), 'Synthetic second ship\n');
  expect((await cli(args)).code).toBe(0);
  expect(provisionBodies).toEqual([]);
  expect(onboardingBodies).toEqual([]);
  const pushed = Bun.spawnSync(['git', '--git-dir', bareRepo, 'show', 'main:README.md']);
  expect(pushed.exitCode).toBe(0);
  expect(pushed.stdout.toString()).toBe('Synthetic second ship\n');
  expect(hits.filter((hit) => hit.path === '/v1/projects/chosen_project')).toHaveLength(3);
});

test.each([false, true])('first ship dismisses onboarding without failing a push when persistence is refused=%s', async (refused) => {
  refuseOnboarding = refused;
  clearDefaults();
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
  expect(onboardingBodies).toEqual([{ completed: true }]);
  expect(provisionBodies).toEqual([
    { name: 'synthetic-workspace', account_id: 'account_workspace', seed_starter: false },
  ]);
  expect(hits.every((hit) => hit.auth === 'Bearer tok_other')).toBe(true);
  expect(hits.map((hit) => hit.path)).toEqual([
    '/v1/accounts/me',
    '/v1/projects/provision',
    '/v1/projects/created_workspace/onboarding',
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


test('projects clone keeps a shipped link and README clean', async () => {
  useLocalRepo = true;
  const hostUrl = `http://127.0.0.1:${server.port}`;
  const binding = JSON.stringify({
    project_id: 'workspace_project',
    account_id: 'account_workspace',
    host: 'workspace',
    host_url: hostUrl,
    linked_at: '2026-01-01T00:00:00.000Z',
  }, null, 2) + '\n';
  writeFileSync(join(cwd, '.kortix/link.json'), binding);
  writeFileSync(join(cwd, 'README.md'), 'Synthetic shipped content\n');
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  };
  git('add', 'kortix.yaml', 'README.md', '.kortix/link.json');
  git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', 'commit', '-m', 'ship fixture');
  git('clone', '--bare', '.', bareRepo);

  for (const destination of ['clone-one', 'clone-two']) {
    const result = await cli(['projects', 'clone', 'workspace_project', destination, '--host', 'workspace']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Cloned Workspace');
    expect(result.stderr).not.toContain('git clone failed');
    const cloned = join(cwd, destination);
    expect(readFileSync(join(cloned, '.kortix/link.json'), 'utf8')).toBe(binding);
    expect(readFileSync(join(cloned, 'README.md'), 'utf8')).toBe('Synthetic shipped content\n');
    const status = Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: cloned });
    expect(status.exitCode).toBe(0);
    expect(status.stdout.toString()).toBe('');
  }
});

test.each([false, true])('seeded managed ship recovery preserves history (fetch fails=%s)', async (failFetch) => {
  useLocalRepo = true;
  managedRepo = true;
  link();
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  git('config', 'user.name', 'Synthetic');
  git('config', 'user.email', 'synthetic@example.test');
  writeFileSync(join(cwd, '.git/info/exclude'), '/remote.git/\n');
  git('add', 'kortix.yaml');
  git('commit', '-m', 'seed');
  git('clone', '--bare', '.', bareRepo);
  const seed = git('--git-dir', bareRepo, 'rev-parse', 'main');
  git('checkout', '--orphan', 'local');
  writeFileSync(join(cwd, 'kortix.yaml'), 'name: local-work\n');
  git('add', 'kortix.yaml');
  git('commit', '-m', 'local work');
  git('branch', '-M', 'main');
  git('add', '-A');
  git('commit', '-m', 'fixture files');
  const local = git('rev-parse', 'HEAD');
  const extraEnv: Record<string, string> = {};
  if (failFetch) {
    const realGit = Bun.which('git');
    if (!realGit) throw new Error('git required');
    const bin = join(cwd, '.git', 'test-bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'git'), `#!/bin/sh
if [ "$1" = fetch ]; then exit 128; fi
exec ${JSON.stringify(realGit)} "$@"
`, { mode: 0o755 });
    extraEnv.PATH = `${bin}:${process.env.PATH}`;
  }
  const result = await cli(['ship', '--host', 'workspace', '--no-verify', '--no-env', '--no-connect', '-y'], extraEnv);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('kortix projects clone workspace_project');
  expect(result.stderr).toContain('Copy your local files');
  expect(result.stderr).toContain('not .git');
  expect(git('--git-dir', bareRepo, 'rev-parse', 'main')).toBe(seed);
  expect(git('merge-base', '--is-ancestor', local, 'HEAD')).toBe('');
  expect(git('show', 'HEAD:kortix.yaml')).toBe('name: local-work');
  expect(hits.some((hit) => hit.path.includes('/git-token'))).toBe(true);
  expect(hits.every((hit) => hit.auth === 'Bearer tok_workspace')).toBe(true);
});

test('creation dismisses onboarding even if credential resolution fails before the first push', async () => {
  clearDefaults();
  refuseCredential = true;
  const result = await cli(['ship', '--no-verify', '--no-env', '--no-connect', '--origin', 'managed', '-y']);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('credential refused');
  expect(onboardingBodies).toEqual([{ completed: true }]);
  expect(hits.map((hit) => hit.path)).toEqual([
    '/v1/accounts/me',
    '/v1/projects/provision',
    '/v1/projects/created_workspace/onboarding',
    '/v1/projects/created_workspace/git-token',
  ]);
});
