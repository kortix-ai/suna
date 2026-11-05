/**
 * `kortix workspaces` as a black box: the real CLI process against a fake API.
 *
 * - A person with no workspace (a new user: `GET /accounts/me` lists no
 *   account) reads one create-or-join line on every entry point.
 * - The workspace flag and env var: `--workspace` is the primary name,
 *   `--project` the older one; KORTIX_WORKSPACE_ID wins over
 *   KORTIX_PROJECT_ID, and a directory link wins over both.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ENTRY = join(resolve(import.meta.dir, '..', '..'), 'src', 'index.ts');
const NO_WORKSPACE =
  'No workspace yet. Create one with kortix workspaces create <name>, or accept an invite.';

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let paths: string[] = [];
let accounts: Array<{ account_id: string; slug: string; name: string; role: string }> = [];

function project(id: string) {
  return {
    project_id: id,
    account_id: 'account_1',
    name: `Workspace ${id}`,
    repo_url: 'https://example.test/r.git',
    default_branch: 'main',
    manifest_path: 'kortix.yaml',
    status: 'active',
    last_opened_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function startServer(): string {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      paths.push(url.pathname);
      if (url.pathname === '/v1/accounts/me') {
        return Response.json({ user_id: 'user_1', email: 'user@example.test', accounts });
      }
      if (url.pathname === '/v1/projects') return Response.json([]);
      const match = url.pathname.match(/^\/v1\/projects\/([^/]+)$/);
      if (match) return Response.json(project(match[1]));
      return Response.json({ error: `unexpected ${url.pathname}` }, { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}/v1`;
}

function writeConfig(apiBase: string, accountId = ''): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: { url: apiBase, token: 'tok_ws', user_id: 'user_1', account_id: accountId, logged_in_at: '2026-01-01T00:00:00.000Z' },
      },
    }),
  );
  return path;
}

async function runCli(args: string[], config: string, env: Record<string, string> = {}, cwd = tmp) {
  const base: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_CONFIG_FILE: config,
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
  };
  for (const key of ['KORTIX_TOKEN', 'KORTIX_API_URL', 'KORTIX_PROJECT_ID', 'KORTIX_WORKSPACE_ID']) delete base[key];
  const proc = Bun.spawn({ cmd: [process.execPath, CLI_ENTRY, ...args], cwd, env: { ...base, ...env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, stdout, stderr };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kortix-workspaces-'));
  paths = [];
  accounts = [];
});

afterEach(() => {
  server?.stop(true);
  server = null;
  rmSync(tmp, { recursive: true, force: true });
});

describe('a person with no workspace', () => {
  test('workspaces ls prints the create-or-join line and exits 0', async () => {
    const r = await runCli(['workspaces', 'ls'], writeConfig(startServer()));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(NO_WORKSPACE);
  });

  test('workspaces ls --json prints an empty array', async () => {
    const r = await runCli(['workspaces', 'ls', '--json'], writeConfig(startServer()));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
  });

  test('workspaces use exits 1 with the create-or-join line', async () => {
    const r = await runCli(['workspaces', 'use'], writeConfig(startServer()));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(NO_WORKSPACE);
  });

  test('accounts ls (older command) prints the same line', async () => {
    const r = await runCli(['accounts', 'ls'], writeConfig(startServer()));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(NO_WORKSPACE);
  });

  test('whoami shows the line in place of a workspace', async () => {
    const r = await runCli(['whoami'], writeConfig(startServer()));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`workspace ${NO_WORKSPACE}`);
    expect(r.stdout).not.toContain('account   ');
  });

  test('whoami with only an empty account (0 projects) shows the line, not "pick one"', async () => {
    accounts = [{ account_id: 'account_1', slug: 'acct', name: 'Empty', role: 'owner' }];
    const r = await runCli(['whoami'], writeConfig(startServer(), 'account_1'));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`workspace ${NO_WORKSPACE}`);
    expect(r.stdout).not.toContain('none selected');
  });
});

describe('workspaces info', () => {
  test('--workspace <id> and --project <id> name the id, like the positional', async () => {
    const config = writeConfig(startServer());
    for (const flag of ['--workspace', '--project']) {
      const r = await runCli(['workspaces', 'info', flag, 'proj_flag', '--json'], config);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).project_id).toBe('proj_flag');
    }
  });
});

describe('the workspace flag and env var', () => {
  const infoId = async (args: string[], env: Record<string, string> = {}, cwd?: string) => {
    const config = writeConfig(startServer(), 'account_1');
    const r = await runCli(['workspaces', 'features', 'ls', '--json', ...args], config, env, cwd);
    expect(`exit=${r.code} ${r.stderr}`).toBe(`exit=0 ${r.stderr}`);
    return paths.filter((p) => p.startsWith('/v1/projects/')).at(-1);
  };

  test('--workspace selects the workspace', async () => {
    expect(await infoId(['--workspace', 'ws_flag'])).toBe('/v1/projects/ws_flag');
  });

  test('--project (older name) still selects it', async () => {
    expect(await infoId(['--project', 'ws_old_flag'])).toBe('/v1/projects/ws_old_flag');
  });

  test('a leading --workspace before the command is lifted', async () => {
    const config = writeConfig(startServer(), 'account_1');
    const r = await runCli(['--workspace', 'ws_lead', 'workspaces', 'features', 'ls', '--json'], config);
    expect(r.code).toBe(0);
    expect(paths).toContain('/v1/projects/ws_lead');
  });

  test('KORTIX_WORKSPACE_ID wins over KORTIX_PROJECT_ID', async () => {
    expect(await infoId([], { KORTIX_WORKSPACE_ID: 'ws_env', KORTIX_PROJECT_ID: 'proj_env' })).toBe(
      '/v1/projects/ws_env',
    );
  });

  test('KORTIX_PROJECT_ID alone still selects it', async () => {
    expect(await infoId([], { KORTIX_PROJECT_ID: 'proj_env' })).toBe('/v1/projects/proj_env');
  });

  test('a directory link wins over KORTIX_WORKSPACE_ID', async () => {
    const dir = join(tmp, 'linked');
    mkdirSync(join(dir, '.kortix'), { recursive: true });
    writeFileSync(
      join(dir, '.kortix', 'link.json'),
      JSON.stringify({ project_id: 'ws_link', account_id: 'account_1', host: 'test', linked_at: '2026-01-01T00:00:00.000Z' }),
    );
    expect(await infoId([], { KORTIX_WORKSPACE_ID: 'ws_env' }, dir)).toBe('/v1/projects/ws_link');
  });
});
