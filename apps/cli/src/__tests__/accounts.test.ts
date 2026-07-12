import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAccounts } from '../commands/accounts.ts';
import { runProjects } from '../commands/projects.ts';
import { activeAccount, defaultProject } from '../api/config.ts';
import { stripAnsi } from '../style.ts';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_STDOUT_WRITE = process.stdout.write;
const ORIGINAL_STDERR_WRITE = process.stderr.write;

const ENV_KEYS = [
  'KORTIX_CLI_TOKEN',
  'KORTIX_EXECUTOR_TOKEN',
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
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ error: `unexpected ${url}` }), { status: 500 });
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
});

describe('kortix projects use', () => {
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
          { status: 200 },
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

describe('kortix projects ls scoping', () => {
  test('scopes the list to the active account', async () => {
    mockApi((url) => {
      if (url.startsWith('https://api.test/v1/projects')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return undefined;
    });
    const code = await runProjects(['ls', '--json']);
    expect(code).toBe(0);
    expect(requests).toEqual(['https://api.test/v1/projects?account_id=account_1']);
  });
});
