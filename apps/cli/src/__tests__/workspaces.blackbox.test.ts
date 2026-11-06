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
let accounts: Array<{ account_id: string; workspace_id?: string | null; slug: string; name: string; role: string }> = [];

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
      if (url.pathname === '/v1/me') {
        return Response.json({ user_id: 'user_1', email: 'user@example.test', accounts });
      }
      if (url.pathname === '/v1/workspaces') return Response.json([]);
      const match = url.pathname.match(/^\/v1\/workspaces\/([^/]+)$/);
      if (match && req.method === 'DELETE') {
        // K2: a delete closes the workspace; owners can restore it for 14 days.
        return Response.json({ ok: true, deleted: true, archived: true, repo_deleted: false, deletion_scheduled_for: '2026-11-20T08:00:00.000Z' });
      }
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
    accounts = [{ account_id: 'account_1', workspace_id: null, slug: 'acct', name: 'Empty', role: 'owner' }];
    const r = await runCli(['whoami'], writeConfig(startServer(), 'account_1'));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`workspace ${NO_WORKSPACE}`);
    expect(r.stdout).not.toContain('none selected');
  });
});

describe('an account id where a workspace id is expected', () => {
  test('members ls --account <account id> retries the legacy /accounts name once on 404 workspace_not_found', async () => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        paths.push(url.pathname);
        if (url.pathname === '/v1/workspaces/acct_legacy/members') {
          return Response.json({ error: 'Workspace not found', code: 'workspace_not_found' }, { status: 404 });
        }
        if (url.pathname === '/v1/accounts/acct_legacy/members') {
          return Response.json([{ user_id: 'user_1', email: 'user@example.test', account_role: 'owner', projects: [] }]);
        }
        return Response.json({ error: `unexpected ${url.pathname}` }, { status: 404 });
      },
    });
    const r = await runCli(['members', 'ls', '--account', 'acct_legacy', '--json'], writeConfig(`http://127.0.0.1:${server.port}/v1`));
    expect(`exit=${r.code} ${r.stderr}`).toBe(`exit=0 ${r.stderr}`);
    expect(paths).toEqual(['/v1/workspaces/acct_legacy/members', '/v1/accounts/acct_legacy/members']);
    expect(JSON.parse(r.stdout)[0].email).toBe('user@example.test');
  });
});

describe('workspaces rm', () => {
  test('a delete that closes the workspace prints until when an owner can restore it', async () => {
    const r = await runCli(['workspaces', 'rm', 'ws_close', '--yes'], writeConfig(startServer(), 'account_1'));
    expect(`exit=${r.code} ${r.stderr}`).toBe(`exit=0 ${r.stderr}`);
    expect(r.stdout).toContain('Deleted');
    expect(r.stdout).toContain('an owner can restore it until 2026-11-20T08:00:00.000Z (POST /v1/workspaces/ws_close/restore)');
    expect(r.stdout).not.toContain('no managed repo to delete');
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
    return paths.filter((p) => p.startsWith('/v1/workspaces/')).at(-1);
  };

  test('--workspace selects the workspace', async () => {
    expect(await infoId(['--workspace', 'ws_flag'])).toBe('/v1/workspaces/ws_flag');
  });

  test('--project (older name) still selects it', async () => {
    expect(await infoId(['--project', 'ws_old_flag'])).toBe('/v1/workspaces/ws_old_flag');
  });

  test('a leading --workspace before the command is lifted', async () => {
    const config = writeConfig(startServer(), 'account_1');
    const r = await runCli(['--workspace', 'ws_lead', 'workspaces', 'features', 'ls', '--json'], config);
    expect(r.code).toBe(0);
    expect(paths).toContain('/v1/workspaces/ws_lead');
  });

  test('KORTIX_WORKSPACE_ID wins over KORTIX_PROJECT_ID', async () => {
    expect(await infoId([], { KORTIX_WORKSPACE_ID: 'ws_env', KORTIX_PROJECT_ID: 'proj_env' })).toBe(
      '/v1/workspaces/ws_env',
    );
  });

  test('KORTIX_PROJECT_ID alone still selects it', async () => {
    expect(await infoId([], { KORTIX_PROJECT_ID: 'proj_env' })).toBe('/v1/workspaces/proj_env');
  });

  test('in a session box, a script that sets KORTIX_PROJECT_ID=<other> targets <other>', async () => {
    // The box env the platform injects: KORTIX_PROJECT_ID in the process env
    // and in the shell env file. No KORTIX_WORKSPACE_ID is injected.
    const envFile = join(tmp, 'agent-env.sh');
    writeFileSync(envFile, "export KORTIX_PROJECT_ID='box_project'\n");
    const box = { KORTIX_DISABLE_SANDBOX_ENV_FILE: '', BASH_ENV: envFile, KORTIX_PROJECT_ID: 'box_project' };
    expect(await infoId([], box)).toBe('/v1/workspaces/box_project');
    expect(await infoId([], { ...box, KORTIX_PROJECT_ID: 'other_project' })).toBe('/v1/workspaces/other_project');
    expect(await infoId([], { ...box, KORTIX_WORKSPACE_ID: 'other_workspace' })).toBe('/v1/workspaces/other_workspace');
  });

  test('a directory link wins over KORTIX_WORKSPACE_ID', async () => {
    const dir = join(tmp, 'linked');
    mkdirSync(join(dir, '.kortix'), { recursive: true });
    writeFileSync(
      join(dir, '.kortix', 'link.json'),
      JSON.stringify({ project_id: 'ws_link', account_id: 'account_1', host: 'test', linked_at: '2026-01-01T00:00:00.000Z' }),
    );
    expect(await infoId([], { KORTIX_WORKSPACE_ID: 'ws_env' }, dir)).toBe('/v1/workspaces/ws_link');
  });
});

/**
 * `kortix projects ls` (the older name) prints what it printed before
 * Workspaces: the active account's projects only, one `GET /projects`, no
 * identity read. `kortix workspaces ls` lists every account and never turns a
 * failed account read into an empty list.
 */
describe('projects ls (older name) keeps its output; workspaces ls surfaces a failed account', () => {
  let failAccount = '';
  let lsPaths: string[] = [];
  function startTwoAccountServer(): string {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        lsPaths.push(`${url.pathname}${url.search}`);
        if (url.pathname === '/v1/me') {
          return Response.json({
            user_id: 'user_1',
            email: 'user@example.test',
            accounts: [
              { account_id: 'account_1', slug: 'one', name: 'One', role: 'owner' },
              { account_id: 'account_2', slug: 'two', name: 'Two', role: 'member' },
            ],
          });
        }
        if (url.pathname === '/v1/workspaces') {
          const account = url.searchParams.get('account_id') ?? '';
          if (account === failAccount) return Response.json({ error: 'synthetic outage' }, { status: 503 });
          if (account === 'account_1') return Response.json([{ ...project('ws_one'), name: 'Alpha' }]);
          if (account === 'account_2') return Response.json([{ ...project('ws_two'), account_id: 'account_2', name: 'Beta' }]);
          return Response.json([]);
        }
        return Response.json({ error: `unexpected ${url.pathname}` }, { status: 404 });
      },
    });
    return `http://127.0.0.1:${server.port}/v1`;
  }
  function writeActiveConfig(apiBase: string): string {
    const path = join(tmp, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        active: 'test',
        hosts: {
          test: {
            url: apiBase, token: 'tok_ws', user_id: 'user_1', account_id: 'account_1',
            account_slug: 'one', account_name: 'One', logged_in_at: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
    );
    return path;
  }
  beforeEach(() => {
    failAccount = '';
    lsPaths = [];
  });

  test('projects ls --json lists only the active account, with one call', async () => {
    const r = await runCli(['projects', 'ls', '--json'], writeActiveConfig(startTwoAccountServer()));
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as Array<{ project_id: string }>).map((p) => p.project_id)).toEqual(['ws_one']);
    expect(lsPaths).toEqual(['/v1/workspaces?account_id=account_1']);
  });

  test('projects ls prints the account header and the older footer', async () => {
    const r = await runCli(['projects', 'ls'], writeActiveConfig(startTwoAccountServer()));
    expect(r.code).toBe(0);
    expect(r.stdout).toStartWith('\n  account  One (one)\n\n');
    expect(r.stdout).toContain('  NAME    REPO');
    expect(r.stdout).toEndWith('\n  1 project in One · spans all accounts: kortix projects ls --all\n\n');
    expect(r.stdout).not.toContain('Beta');
  });

  test('projects ls --all keeps the older section text', async () => {
    failAccount = 'account_2';
    const r = await runCli(['projects', 'ls', '--all'], writeActiveConfig(startTwoAccountServer()));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('— no projects');
    expect(r.stdout).toContain('1 project across 2 accounts');
  });

  test('workspaces ls lists every account', async () => {
    const r = await runCli(['workspaces', 'ls', '--json'], writeActiveConfig(startTwoAccountServer()));
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as Array<{ project_id: string }>).map((p) => p.project_id)).toEqual(['ws_one', 'ws_two']);
  });

  test('workspaces ls names a failed account and exits 1 instead of printing it empty', async () => {
    failAccount = 'account_2';
    for (const args of [['workspaces', 'ls'], ['workspaces', 'ls', '--json']]) {
      const r = await runCli(args, writeActiveConfig(startTwoAccountServer()));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('two');
      expect(r.stderr).toContain('synthetic outage');
      expect(r.stdout).toContain('ws_one');
    }
  });
});

describe('one workspace context for workspace-level commands (CLI-WS-1)', () => {
  // W is the default workspace; W2 is another one the person belongs to.
  const W = 'aaaaaaaa-0000-4000-8000-000000000001';
  const W2 = 'aaaaaaaa-0000-4000-8000-000000000002';
  let seen: string[] = [];

  function startStateServer(): string {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        seen.push(`${url.pathname}${url.search}`);
        if (url.pathname === '/v1/billing/account-state') {
          const id = url.searchParams.get('account_id');
          return Response.json({ account_id: id, tier: { name: id === W2 ? 'pro' : 'free' } });
        }
        const members = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/members$/);
        if (members) return Response.json([]);
        return Response.json({ error: `unexpected ${url.pathname}` }, { status: 404 });
      },
    });
    return `http://127.0.0.1:${server.port}/v1`;
  }

  function writeDefaultConfig(apiBase: string): string {
    const path = join(tmp, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        active: 'test',
        hosts: {
          test: {
            url: apiBase, token: 'tok_ws', user_id: 'user_1', account_id: 'account_1',
            default_project: { project_id: W, account_id: 'account_1', name: 'Workspace W' },
            logged_in_at: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
    );
    return path;
  }

  beforeEach(() => {
    seen = [];
  });

  test('billing status --workspace W2 reads W2, not the default workspace W', async () => {
    const r = await runCli(['billing', 'status', '--workspace', W2, '--json'], writeDefaultConfig(startStateServer()));
    expect(`exit=${r.code} ${r.stderr}`).toBe(`exit=0 ${r.stderr}`);
    expect(seen).toEqual([`/v1/billing/account-state?account_id=${W2}`]);
    expect(JSON.parse(r.stdout).tier.name).toBe('pro');
  });

  test('billing status with no flag reads the default workspace', async () => {
    const r = await runCli(['billing', 'status', '--json'], writeDefaultConfig(startStateServer()));
    expect(r.code).toBe(0);
    expect(seen).toEqual([`/v1/billing/account-state?account_id=${W}`]);
  });

  test('KORTIX_WORKSPACE_ID, then KORTIX_PROJECT_ID, outrank the default workspace', async () => {
    const config = writeDefaultConfig(startStateServer());
    await runCli(['members', 'ls', '--json'], config, { KORTIX_PROJECT_ID: W2 });
    await runCli(['members', 'ls', '--json'], config, { KORTIX_PROJECT_ID: W, KORTIX_WORKSPACE_ID: W2 });
    expect(seen).toEqual([`/v1/workspaces/${W2}/members?account_id=${W2}`, `/v1/workspaces/${W2}/members?account_id=${W2}`]);
  });

  test('a session box (only KORTIX_TOKEN + KORTIX_PROJECT_ID) runs members ls in its workspace', async () => {
    const apiBase = startStateServer();
    const r = await runCli(['members', 'ls', '--json'], join(tmp, 'absent.json'), {
      KORTIX_TOKEN: 'tok_session',
      KORTIX_API_URL: apiBase,
      KORTIX_PROJECT_ID: W,
    });
    expect(`exit=${r.code} ${r.stderr}`).toBe(`exit=0 ${r.stderr}`);
    expect(JSON.parse(r.stdout)).toEqual([]);
    expect(seen).toEqual([`/v1/workspaces/${W}/members?account_id=${W}`]);
  });
});

describe('a workspace-bound credential (CLI-WS-2)', () => {
  const W = 'bbbbbbbb-0000-4000-8000-000000000001';
  let seen: string[] = [];

  function startBoundServer(): string {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        seen.push(url.pathname);
        if (url.pathname === '/v1/me') {
          return Response.json({
            user_id: 'user_1',
            email: 'user@example.test',
            token_context: {
              auth_type: 'pat', project_id: W, workspace_id: W, session_id: null, agent: null,
              connectors: null, kortix_permissions: null, kortix_cli: null,
            },
            accounts: [
              { account_id: 'account_1', workspace_id: W, slug: 'account_', name: 'Bound Lab', role: 'owner' },
              { account_id: 'account_2', workspace_id: 'other-ws', slug: 'account_', name: 'Other', role: 'member' },
            ],
          });
        }
        // The fence: a bound credential cannot list workspaces on an older server.
        if (url.pathname === '/v1/workspaces') {
          return Response.json({ message: 'refused [check=token-project-scope:project-list]' }, { status: 403 });
        }
        if (url.pathname === `/v1/workspaces/${W}`) return Response.json({ ...project(W), name: 'Bound Lab' });
        return Response.json({ error: `unexpected ${url.pathname}` }, { status: 404 });
      },
    });
    return `http://127.0.0.1:${server.port}/v1`;
  }

  const boundEnv = (apiBase: string) => ({ KORTIX_TOKEN: 'tok_bound', KORTIX_API_URL: apiBase, KORTIX_PROJECT_ID: W });

  beforeEach(() => {
    seen = [];
  });

  test('whoami prints the bound workspace, reads no list, never "No workspace yet"', async () => {
    const r = await runCli(['whoami'], join(tmp, 'absent.json'), boundEnv(startBoundServer()));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`workspace Bound Lab (${W}, owner, bound)`);
    expect(r.stdout).not.toContain(NO_WORKSPACE);
    expect(seen).toEqual(['/v1/me']);
  });

  test('whoami --json carries the bound workspace_id', async () => {
    const r = await runCli(['whoami', '--json'], join(tmp, 'absent.json'), boundEnv(startBoundServer()));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).workspace_id).toBe(W);
  });

  test('workspaces ls prints its one workspace and exits 0', async () => {
    const r = await runCli(['workspaces', 'ls'], join(tmp, 'absent.json'), boundEnv(startBoundServer()));
    expect(`exit=${r.code} ${r.stderr}`).toBe(`exit=0 ${r.stderr}`);
    expect(r.stdout).toContain('Bound Lab');
    expect(r.stdout).toContain('1 workspace');
    expect(r.stdout).not.toContain(NO_WORKSPACE);
    expect(seen).toEqual(['/v1/me', `/v1/workspaces/${W}`]);
  });
});

describe('a failed list never reads as "No workspace yet"', () => {
  test('workspaces ls whose every read fails exits 1 with the failure and no create-or-join line', async () => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/v1/me') {
          return Response.json({ user_id: 'user_1', email: 'user@example.test', accounts: [{ account_id: 'account_1', workspace_id: null, slug: 'acct', name: 'Lab', role: 'owner' }] });
        }
        return Response.json({ message: 'synthetic outage' }, { status: 503 });
      },
    });
    const r = await runCli(['workspaces', 'ls'], writeConfig(`http://127.0.0.1:${server.port}/v1`, 'account_1'));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('synthetic outage');
    expect(r.stdout).not.toContain(NO_WORKSPACE);
  });
});

describe('a flag a subcommand does not read is refused (CLI-WS-3)', () => {
  test('billing status --since exits 2 and sends nothing', async () => {
    let calls = 0;
    server = Bun.serve({ port: 0, fetch() { calls += 1; return Response.json({}); } });
    const r = await runCli(['billing', 'status', '--since', '7d'], writeConfig(`http://127.0.0.1:${server.port}/v1`, 'account_1'));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('billing status does not take --since');
    expect(calls).toBe(0);
  });
});
