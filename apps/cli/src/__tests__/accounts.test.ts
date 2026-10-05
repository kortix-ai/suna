import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAccounts } from '../commands/accounts.ts';
import { runProjects } from '../commands/projects.ts';
import { activeAccount, defaultProject, loadConfig } from '../api/config.ts';
import { stripAnsi } from '../style.ts';

const JSON_HEADERS = { 'content-type': 'application/json' };

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_STDOUT_WRITE = process.stdout.write;
const ORIGINAL_STDERR_WRITE = process.stderr.write;

const ENV_KEYS = [
  'KORTIX_TOKEN',
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_FRONTEND_URL',
  'KORTIX_PROJECT_ID',
  'BASH_ENV',
  'KORTIX_DISABLE_SANDBOX_ENV_FILE',
  'KORTIX_CONFIG_FILE',
  'KORTIX_AUTH_FILE',
] as const;

let saved: Record<string, string | undefined>;
let tmp: string;
let originalCwd: string;
let stdout = '';
let stderr = '';
let requests: string[] = [];

const ACCOUNTS = [
  { account_id: 'account_1', slug: 'personal', name: 'Personal', role: 'owner' },
  { account_id: 'account_2', slug: 'kortix', name: 'Kortix', role: 'owner' },
];

function writeConfig(activeAccountId = 'account_1'): void {
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
          account_id: activeAccountId,
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
    'utf8',
  );
  process.env.KORTIX_CONFIG_FILE = file;
}

function captureOutput() {
  stdout = '';
  stderr = '';
  (process.stdout as any).write = (chunk: unknown) => {
    stdout += String(chunk);
    return true;
  };
  (process.stderr as any).write = (chunk: unknown) => {
    stderr += String(chunk);
    return true;
  };
}

function mockApi(extra?: (url: string) => Response | undefined) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    const custom = extra?.(url);
    if (custom) return custom;
    if (url === 'https://api.test/v1/accounts/me') {
      return new Response(
        JSON.stringify({ user_id: 'user_1', email: 'user@example.test', accounts: ACCOUNTS }),
        { status: 200, headers: JSON_HEADERS },
      );
    }
    return new Response(JSON.stringify({ error: `unexpected ${url}` }), { status: 500, headers: JSON_HEADERS });
  }) as typeof fetch;
}

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
  originalCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'kortix-accounts-test-'));
  process.chdir(tmp);
  writeConfig();
  captureOutput();
  requests = [];
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  (process.stdout as any).write = ORIGINAL_STDOUT_WRITE;
  (process.stderr as any).write = ORIGINAL_STDERR_WRITE;
  process.chdir(originalCwd);
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('kortix accounts', () => {
  test('ls lists accounts and marks the active one (no account scoping on /me)', async () => {
    mockApi();
    const code = await runAccounts(['ls']);
    expect(code).toBe(0);
    expect(requests).toEqual(['https://api.test/v1/accounts/me']);
    const out = stripAnsi(stdout);
    expect(out).toContain('Personal');
    expect(out).toContain('Kortix');
    // The active account (account_1 = Personal) is bulleted.
    expect(out).toMatch(/●\s+Personal/);
  });

  test('ls --json reports the active flag', async () => {
    mockApi();
    const code = await runAccounts(['ls', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as Array<{ slug: string; active: boolean }>;
    expect(parsed.find((a) => a.slug === 'personal')?.active).toBe(true);
    expect(parsed.find((a) => a.slug === 'kortix')?.active).toBe(false);
  });

  test('use <slug> switches the active account', async () => {
    mockApi();
    const code = await runAccounts(['use', 'kortix']);
    expect(code).toBe(0);
    expect(activeAccount()).toEqual({ id: 'account_2', slug: 'kortix', name: 'Kortix' });
    expect(stripAnsi(stdout)).toContain('Active account is now Kortix');
  });

  test('use rejects an unknown account', async () => {
    mockApi();
    const code = await runAccounts(['use', 'nope']);
    expect(code).toBe(1);
    expect(stripAnsi(stderr)).toContain('No account "nope"');
    // Active account is unchanged.
    expect(activeAccount()?.id).toBe('account_1');
  });

  test('current prints the active account', async () => {
    mockApi();
    await runAccounts(['use', 'kortix']);
    stdout = '';
    const code = await runAccounts(['current']);
    expect(code).toBe(0);
    expect(stripAnsi(stdout)).toContain('Kortix');
  });

  test('current --json prints the account object and exits 0', async () => {
    mockApi();
    await runAccounts(['use', 'kortix']);
    stdout = '';
    const code = await runAccounts(['current', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ account_id: 'account_2', slug: 'kortix', name: 'Kortix' });
  });

  test('current --json exits nonzero when no account is active', async () => {
    mockApi();
    // A `kortix login --no-project` on an account-less login leaves account_id empty.
    writeConfig('');
    const code = await runAccounts(['current', '--json']);
    expect(code).toBe(1);
    // stdout stays a valid JSON document; the failure is the exit code.
    expect(JSON.parse(stdout)).toBeNull();
    expect(stripAnsi(stderr)).toContain('No active account');
  });
});

describe('kortix projects use', () => {
  for (const body of [
    { error: 'Project lookup unavailable' },
    {},
    null,
    { project_id: 'proj_x', name: 'Beta' },
    { project_id: 'proj_x', account_id: 42, name: 'Beta' },
    { project_id: '', account_id: 'account_2', name: 'Beta' },
  ]) {
    test(`rejects an invalid project response: ${JSON.stringify(body)}`, async () => {
      mockApi((url) => url.endsWith('/projects/proj_x')
        ? new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS })
        : undefined);
      const before = loadConfig();
      expect(await runProjects(['use', 'proj_x'])).toBe(1);
      expect(stripAnsi(stderr)).toContain('Invalid project response');
      if (body && 'error' in body && typeof body.error === 'string') expect(stderr).toContain(body.error);
      expect(stderr).not.toContain('TypeError');
      expect(loadConfig()).toEqual(before);
      expect(stdout).toBe('');
    });
  }

  test('sets the default project and switches the active account to its account', async () => {
    mockApi((url) => {
      if (url === 'https://api.test/v1/projects/proj_x') {
        return new Response(
          JSON.stringify({
            project_id: 'proj_x',
            account_id: 'account_2',
            name: 'Beta',
            repo_url: 'https://github.com/x/beta.git',
            default_branch: 'main',
            manifest_path: 'kortix.yaml',
            status: 'active',
            last_opened_at: null,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          }),
          { status: 200, headers: JSON_HEADERS },
        );
      }
      return undefined;
    });

    const code = await runProjects(['use', 'proj_x']);
    expect(code).toBe(0);
    // The by-id GET is NOT account-scoped (the project may be in any account).
    expect(requests).toContain('https://api.test/v1/projects/proj_x');
    // Default project recorded …
    expect(defaultProject()).toEqual({ project_id: 'proj_x', account_id: 'account_2', name: 'Beta' });
    // … and the active account followed it to Kortix (account_2).
    expect(activeAccount()).toEqual({ id: 'account_2', slug: 'kortix', name: 'Kortix' });
    const out = stripAnsi(stdout);
    expect(out).toContain('Default project: Beta');
    expect(out).toContain('now active');
  });
});

describe('kortix projects use (picker)', () => {
  test('rejects a bad /projects list and one bad row without touching state', async () => {
    mockApi((url) => url === 'https://api.test/v1/projects' || url === 'https://api.test/v1/projects?account_id=account_1'
      ? new Response(JSON.stringify([{ project_id: 'proj_x', account_id: 'account_2', name: 'Beta' }, {}]), { status: 200, headers: JSON_HEADERS })
      : undefined);
    const before = loadConfig();
    expect(await runProjects(['use'])).toBe(1);
    expect(stripAnsi(stderr)).toContain('Invalid project response');
    expect(stderr).not.toContain('TypeError');
    expect(loadConfig()).toEqual(before);
    expect(stdout).toBe('');
  });
});

describe('kortix projects use --host', () => {
  const OTHER_PROJECT = {
    project_id: 'proj_other',
    account_id: 'account_9',
    name: 'Other',
    repo_url: 'https://github.com/x/other.git',
    default_branch: 'main',
    manifest_path: 'kortix.yaml',
    status: 'active',
    last_opened_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };

  /** Two logged-in hosts: `test` (active) and `other`, each with its own API
   *  base, token and account — the cross-host setup the journey reports. */
  function writeTwoHostConfig(): void {
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
          other: {
            url: 'https://api.other',
            token: 'tok_other',
            user_id: 'user_9',
            user_email: 'user9@example.test',
            account_id: 'account_9',
            logged_in_at: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
      'utf8',
    );
    process.env.KORTIX_CONFIG_FILE = file;
  }

  /** Serve GET /projects/proj_other on host `other`; anything else 500s, so
   *  a call that rides the active host fails the test. */
  function mockOtherProject(): void {
    mockApi((url) => {
      if (url === 'https://api.other/v1/projects/proj_other') {
        return new Response(JSON.stringify(OTHER_PROJECT), { status: 200, headers: JSON_HEADERS });
      }
      return undefined;
    });
  }

  test('routes the request and the default binding to the named host', async () => {
    writeTwoHostConfig();
    mockOtherProject();

    const code = await runProjects(['use', 'proj_other', '--host', 'other']);
    expect(code).toBe(0);
    expect(requests).toEqual(['https://api.other/v1/projects/proj_other']);
    // The default project binds to the NAMED host entry, not the active one.
    const cfg = loadConfig();
    expect(cfg.hosts.other?.default_project).toEqual({
      project_id: 'proj_other',
      account_id: 'account_9',
      name: 'Other',
    });
    expect(cfg.hosts.test?.default_project).toBeUndefined();
    expect(defaultProject()).toBeNull(); // the active host gained nothing
  });

  test('ignores the ambient sandbox env token when --host names a logged-in host', async () => {
    writeTwoHostConfig();
    // The platform-injected session credential: activeHost() prefers it, so
    // before the fix the request rode the ambient session token and 403'd.
    process.env.KORTIX_TOKEN = 'tok_sandbox';
    process.env.KORTIX_API_URL = 'https://api.sandbox';
    mockOtherProject();

    const code = await runProjects(['use', 'proj_other', '--host', 'other']);
    expect(code).toBe(0);
    expect(requests).toEqual(['https://api.other/v1/projects/proj_other']);
  });

  test('ignores the sandbox env file when --host names a logged-in host', async () => {
    writeTwoHostConfig();
    // The env-FILE variant of the same override: inside a sandbox the
    // platform sources agent-env.sh into every shell, so the four env vars
    // are unset on the process yet `sandboxEnvValue` still resolves them
    // from the file. BASH_ENV pointing at a temp agent-env.sh takes
    // priority over the real /dev/shm path (candidatePaths), which keeps
    // this hermetic on machines that have the file.
    delete process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE;
    const envFile = join(tmp, 'agent-env.sh');
    writeFileSync(
      envFile,
      "export KORTIX_TOKEN='tok_sandbox'\nexport KORTIX_API_URL='https://api.sandbox'\n",
      'utf8',
    );
    process.env.BASH_ENV = envFile;
    mockOtherProject();

    const code = await runProjects(['use', 'proj_other', '--host', 'other']);
    expect(code).toBe(0);
    expect(requests).toEqual(['https://api.other/v1/projects/proj_other']);
    // The default binds on the named host's entry, not the ambient env host.
    expect(loadConfig().hosts.other?.default_project).toEqual({
      project_id: 'proj_other',
      account_id: 'account_9',
      name: 'Other',
    });
  });

  test('switches the named host active account, not the ambient one', async () => {
    writeTwoHostConfig();
    mockApi((url) => {
      if (url === 'https://api.other/v1/projects/proj_other') {
        return new Response(
          JSON.stringify({ ...OTHER_PROJECT, account_id: 'account_10' }),
          { status: 200, headers: JSON_HEADERS },
        );
      }
      if (url === 'https://api.other/v1/accounts/me') {
        return new Response(
          JSON.stringify({
            user_id: 'user_9',
            email: 'user9@example.test',
            accounts: [{ account_id: 'account_10', slug: 'moved', name: 'Moved', role: 'owner' }],
          }),
          { status: 200, headers: JSON_HEADERS },
        );
      }
      return undefined;
    });

    const code = await runProjects(['use', 'proj_other', '--host', 'other']);
    expect(code).toBe(0);
    expect(requests).toEqual([
      'https://api.other/v1/projects/proj_other',
      'https://api.other/v1/accounts/me',
    ]);
    const cfg = loadConfig();
    expect(cfg.hosts.other?.account_id).toBe('account_10');
    expect(cfg.hosts.other?.default_project?.account_id).toBe('account_10');
    // The ambient active host keeps its own account and default.
    expect(cfg.hosts.test?.account_id).toBe('account_1');
    expect(cfg.hosts.test?.default_project).toBeUndefined();
  });

  test('refuses a host that is not logged in', async () => {
    writeTwoHostConfig();
    mockApi();
    const code = await runProjects(['use', 'proj_other', '--host', 'nosuch']);
    expect(code).toBe(1);
    expect(stripAnsi(stderr)).toContain('Host "nosuch" is not logged in');
    expect(requests).toEqual([]);
  });

  test('unset --host clears that host entry only', async () => {
    writeTwoHostConfig();
    mockOtherProject();
    await runProjects(['use', 'proj_other', '--host', 'other']);
    stdout = '';

    const code = await runProjects(['unset', '--host', 'other']);
    expect(code).toBe(0);
    expect(loadConfig().hosts.other?.default_project).toBeUndefined();
    expect(stripAnsi(stdout)).toContain('Cleared the default project');
  });
});

describe('kortix projects ls scoping', () => {
  test('scopes the list to the active account', async () => {
    mockApi((url) => {
      if (url.startsWith('https://api.test/v1/projects')) {
        return new Response(JSON.stringify([]), { status: 200, headers: JSON_HEADERS });
      }
      return undefined;
    });
    const code = await runProjects(['ls', '--json']);
    expect(code).toBe(0);
    expect(requests).toEqual(['https://api.test/v1/projects?account_id=account_1']);
  });
});
