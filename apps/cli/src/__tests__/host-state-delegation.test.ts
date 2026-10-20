// Host and default-project consistency under the delegated (env-token)
// identity — KRTX-2702 (KRTX-1951, KRTX-1936, KRTX-1804).
//
// Inside a sandbox the platform injects KORTIX_TOKEN + KORTIX_API_URL +
// KORTIX_PROJECT_ID. That env host is synthetic: it never carries the
// persisted identity state (active account, default project) — that state
// lives on the stored active host, the one `accounts use` and `projects use`
// write. Ambient commands that READ that state must therefore read the stored
// active host, and a `--host`-pinned project command must resolve the named
// host's own project chain instead of the ambient session ids.
//
// Black-box: every run is a real CLI process against real fake APIs with a
// real on-disk config, the same contract as `accounts-host.test.ts`.

import { afterEach, beforeEach, describe, expect, it, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveProjectId } from '../project-link.ts';
import { type FakeApi, startFakeApi } from './support/account-cli-harness.ts';
const memberships = [
  { account_id: 'account_1', slug: 'acct', name: 'Acct', role: 'owner' },
  { account_id: 'account_2', slug: 'second', name: 'Second', role: 'owner' },
];

function projectRow(projectId: string, name: string, accountId: string) {
  return {
    project_id: projectId,
    name,
    account_id: accountId,
    repo_url: `https://git.example.test/${projectId}.git`,
    default_branch: 'main',
    manifest_path: 'kortix.yaml',
    status: 'active',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

const otherAssignments = [
  {
    id: 'as_1',
    role_key: 'owner',
    principal_type: 'user',
    principal_id: 'user_1',
    scope_type: 'project',
    scope_id: 'proj_other',
    source: 'direct',
  },
];

let tmp: string;
let named: FakeApi;
let other: FakeApi;
let delegated: FakeApi;
let configFile: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'host-state-delegation-'));
  named = startFakeApi((req, url) => {
    if (req.method === 'GET' && url.pathname === '/v1/accounts/me') {
      return Response.json({
        user_id: 'user_1',
        email: 'user@example.test',
        accounts: memberships,
      });
    }
    if (req.method === 'GET' && url.pathname === '/v1/projects/proj_1') {
      return Response.json(projectRow('proj_1', 'P1', 'account_1'));
    }
    return undefined;
  });
  other = startFakeApi((req, url) => {
    if (req.method === 'GET' && url.pathname === '/v1/projects/proj_other') {
      return Response.json(projectRow('proj_other', 'PO', 'account_other'));
    }
    if (req.method === 'DELETE' && url.pathname === '/v1/projects/proj_other') {
      return Response.json({ ok: true, archived: true, repo_deleted: false });
    }
    if (req.method === 'GET' && url.pathname === '/v1/accounts/account_other/iam/assignments') {
      return Response.json({ assignments: otherAssignments });
    }
    return undefined;
  });
  delegated = startFakeApi((req, url) => {
    if (req.method === 'GET' && url.pathname === '/v1/accounts/me') {
      return Response.json({
        user_id: 'agent_1',
        email: 'agent@example.test',
        accounts: memberships,
      });
    }
    if (req.method === 'GET' && url.pathname === '/v1/projects/proj_env') {
      return Response.json(projectRow('proj_env', 'Env', 'account_1'));
    }
    return undefined;
  });
  configFile = join(tmp, 'config.json');
  const host = (url: string, token: string, extra: Record<string, unknown> = {}) => ({
    url,
    token,
    user_id: 'user_1',
    user_email: 'user@example.test',
    account_id: 'account_1',
    account_slug: 'acct',
    account_name: 'Acct',
    logged_in_at: '2026-01-01T00:00:00.000Z',
    ...extra,
  });
  writeFileSync(
    configFile,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: host(named.url, 'tok_test', {
          default_project: { project_id: 'proj_1', account_id: 'account_1', name: 'P1' },
        }),
        other: host(other.url, 'tok_other', {
          account_id: 'account_other',
          default_project: { project_id: 'proj_other', account_id: 'account_other', name: 'PO' },
        }),
      },
    }),
  );
});

afterEach(() => {
  named.stop();
  other.stop();
  delegated.stop();
  rmSync(tmp, { recursive: true, force: true });
});

async function run(args: string[]) {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, '../index.ts'), ...args], {
    cwd: tmp,
    env: {
      ...process.env,
      HOME: tmp,
      KORTIX_CONFIG_FILE: configFile,
      KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
      KORTIX_TOKEN: 'delegated-token',
      KORTIX_API_URL: delegated.url,
      KORTIX_PROJECT_ID: 'proj_env',
      KORTIX_NO_UPDATE_CHECK: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

// ── KRTX-1951: accounts current recognizes the stored active account ───────

test('accounts current reads the stored active host account while the delegated env wins', async () => {
  const result = await run(['accounts', 'current', '--json']);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    account_id: 'account_1',
    slug: 'acct',
    name: 'Acct',
  });
  // A config read: neither the named host's API nor the delegated one is contacted.
  expect(named.requests).toEqual([]);
  expect(delegated.requests).toEqual([]);
});

test('accounts ls marks the stored host account inside the delegated identity list', async () => {
  const result = await run(['accounts', 'ls', '--json']);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([
    { ...memberships[0], active: true },
    { ...memberships[1], active: false },
  ]);
  expect(delegated.requests.map((r) => r.path)).toEqual(['/v1/accounts/me']);
});

test('accounts use under the delegated env writes the stored active host and current follows', async () => {
  const use = await run(['accounts', 'use', 'second']);
  expect(use.code).toBe(0);
  const after = JSON.parse(readFileSync(configFile, 'utf8'));
  expect(after.active).toBe('test');
  expect(after.hosts.test.account_id).toBe('account_2');
  expect(after.hosts.test.account_slug).toBe('second');
  // The stored default project lived in the old account — switching clears it.
  expect(after.hosts.test.default_project).toBeUndefined();
  const current = await run(['accounts', 'current', '--json']);
  expect(current.code).toBe(0);
  expect(JSON.parse(current.stdout).account_id).toBe('account_2');
});

// ── KRTX-1804: token/whoami --json surface the persisted default project ───

test('token --json and whoami --json carry the stored host default project', async () => {
  for (const cmd of ['token', 'whoami']) {
    const result = await run([cmd, '--json']);
    expect(result.code).toBe(0);
    const json = JSON.parse(result.stdout);
    // KRTX-2290: the label names the identity the command acts as — under the
    // delegated env that is the synthetic `sandbox` host, while the persisted
    // default project below comes from the stored host (KRTX-1804).
    expect(json.host).toBe('sandbox');
    expect(json.default_project).toEqual({
      project_id: 'proj_1',
      account_id: 'account_1',
      name: 'P1',
    });
  }
  // Both read the delegated identity over the network, nothing else.
  expect(delegated.requests.map((r) => r.path)).toEqual(['/v1/accounts/me', '/v1/accounts/me']);
});

// ── KRTX-1936: --host-pinned project resolution uses the host's own default ──

test('projects info --host resolves the named host own default, not the ambient session project', async () => {
  const result = await run(['projects', 'info', '--host', 'other', '--json']);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).id).toBe('proj_other');
  expect(other.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
    'GET /v1/projects/proj_other',
  ]);
});

test('projects rm -y --host purges the named host own default without an id', async () => {
  const result = await run(['projects', 'rm', '-y', '--host', 'other']);
  expect(result.code).toBe(0);
  expect(other.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
    'GET /v1/projects/proj_other',
    'DELETE /v1/projects/proj_other',
  ]);
});

test('access assignments --host resolves the named host project, not the ambient session project', async () => {
  // The env pins KORTIX_PROJECT_ID=proj_env: without the --host wiring the
  // scope probe would fetch the ambient project against the other host's
  // credential and 404. With it, the scope is the other host's own default
  // project and the IAM list is read from that host's account.
  const result = await run(['access', 'assignments', '--host', 'other', '--json']);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ assignments: otherAssignments });
  expect(other.requests.map((r) => `${r.method} ${r.path}${r.query}`)).toEqual([
    // The project read takes its account from the project row, not a query
    // string; the IAM list is read under the project's own account.
    'GET /v1/projects/proj_other',
    'GET /v1/accounts/account_other/iam/assignments?scope_type=project&scope_id=proj_other&account_id=account_other',
  ]);
});

test('projects info --host --json keeps stdout machine-pure when it fails', async () => {
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  delete config.hosts.other.default_project;
  writeFileSync(configFile, JSON.stringify(config));
  const result = await run(['projects', 'info', '--host', 'other', '--json']);
  expect(result.code).not.toBe(0);
  // Nothing on stdout: a failing --json command must not pollute the JSON
  // stream with host or error lines (KRTX-1936 source update).
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('No project linked');
  expect(result.stderr).not.toContain('proj_env');
});

test('an explicit id still targets the named host exactly (guard)', async () => {
  const result = await run(['projects', 'info', 'proj_env', '--host', 'other']);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('not found on host "other"');
  expect(other.requests.map((r) => r.path)).toEqual(['/v1/projects/proj_env']);
});

test('without --host the ambient session project still resolves (guard)', async () => {
  const result = await run(['projects', 'info', '--json']);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).id).toBe('proj_env');
  expect(delegated.requests.map((r) => r.path)).toEqual(['/v1/projects/proj_env']);
});

// ── resolveProjectId unit contract (the shared resolver the four project
//    call sites and access use) ──────────────────────────────────────────────

const ENV_KEYS = [
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_DISABLE_SANDBOX_ENV_FILE',
  'KORTIX_CONFIG_FILE',
  'KORTIX_AUTH_FILE',
] as const;

function hostEntry(
  token: string,
  defaultProject?: { project_id: string; account_id: string; name?: string },
) {
  return {
    url: 'https://api.example.test',
    token,
    user_id: 'u',
    user_email: 'user@example.test',
    account_id: 'acct-1',
    logged_in_at: '2026-01-01T00:00:00.000Z',
    ...(defaultProject ? { default_project: defaultProject } : {}),
  };
}

describe('resolveProjectId with a named host', () => {
  let dir: string;
  let savedCwd: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
    process.env.KORTIX_TOKEN = 'env-token';
    process.env.KORTIX_API_URL = 'https://env.example.test';
    process.env.KORTIX_PROJECT_ID = 'proj-env';
    dir = mkdtempSync(join(tmpdir(), 'kortix-resolve-id-'));
    process.env.KORTIX_CONFIG_FILE = join(dir, 'config.json');
    writeFileSync(
      process.env.KORTIX_CONFIG_FILE,
      JSON.stringify({
        active: 'home',
        hosts: {
          home: hostEntry('tok_home', { project_id: 'proj-home-default', account_id: 'acct-1' }),
          other: hostEntry('tok_other', { project_id: 'proj-other-default', account_id: 'acct-1' }),
        },
      }),
    );
    savedCwd = process.cwd();
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    rmSync(dir, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('resolves the named host stored default over the ambient chain', () => {
    expect(resolveProjectId(undefined, { hostScoped: false, hostArg: 'other' })).toBe(
      'proj-other-default',
    );
    expect(resolveProjectId(undefined, { hostScoped: false, hostArg: 'home' })).toBe(
      'proj-home-default',
    );
  });

  it('prefers a link bound to the named host and ignores one bound elsewhere', () => {
    const link = (host: string, projectId: string) => {
      mkdirSync(join(dir, '.kortix'), { recursive: true });
      writeFileSync(
        join(dir, '.kortix', 'link.json'),
        JSON.stringify({
          project_id: projectId,
          account_id: 'acct-1',
          host,
          linked_at: '2026-01-01T00:00:00.000Z',
        }),
      );
    };
    link('other', 'proj-link-other');
    expect(resolveProjectId(undefined, { hostArg: 'other' })).toBe('proj-link-other');
    link('home', 'proj-link-home');
    expect(resolveProjectId(undefined, { hostArg: 'other' })).toBe('proj-other-default');
  });

  it('returns null when the named host has neither a link nor a default (no ambient leak)', () => {
    const configPath = process.env.KORTIX_CONFIG_FILE ?? '';
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    delete config.hosts.other.default_project;
    writeFileSync(configPath, JSON.stringify(config));
    expect(resolveProjectId(undefined, { hostArg: 'other' })).toBeNull();
  });

  it('without a host name the ambient chain is unchanged: the env project id wins', () => {
    expect(resolveProjectId()).toBe('proj-env');
  });

  it('an in-sandbox hosts use selection (hostScoped + marker) still scopes to the selected host', () => {
    const configPath = process.env.KORTIX_CONFIG_FILE ?? '';
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    // `hosts use other` selects AND activates the host.
    config.active = 'other';
    config.sandbox_selected = 'other';
    writeFileSync(configPath, JSON.stringify(config));
    expect(resolveProjectId(undefined, { hostScoped: true })).toBe('proj-other-default');
  });
});
