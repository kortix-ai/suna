import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runHosts } from '../commands/hosts.ts';
import { runLogin } from '../commands/login.ts';
import { runLogout } from '../commands/logout.ts';
import { runWhoami } from '../commands/whoami.ts';
import { getHost, loadConfig } from '../api/config.ts';
import { stripAnsi } from '../style.ts';

// The host-centric auth surface: `kortix hosts login/logout/whoami` and the
// thin top-level `login`/`logout`/`whoami` aliases must delegate to the SAME
// shared helpers (performLogin/performLogout/performWhoami) and behave
// identically. These lock that in against the real config store (per-host
// token storage on disk) with a mocked `/accounts/me`.

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

/** Write a config whose active `test` host is optionally already signed in. */
function writeConfig(token = 'tok_test'): void {
  const file = join(tmp, 'config.json');
  writeFileSync(
    file,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: 'https://api.test',
          token,
          user_id: token ? 'user_1' : '',
          user_email: token ? 'user@example.test' : '',
          account_id: token ? 'account_1' : '',
          logged_in_at: token ? '2026-01-01T00:00:00.000Z' : '',
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

function mockApi(accounts: typeof ACCOUNTS = ACCOUNTS) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith('/v1/accounts/me')) {
      return new Response(
        JSON.stringify({ user_id: 'user_1', email: 'user@example.test', accounts }),
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
  tmp = mkdtempSync(join(tmpdir(), 'kortix-hosts-auth-'));
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

describe('kortix hosts login', () => {
  test('--token authenticates the active host (defaults to active)', async () => {
    writeConfig(''); // logged out
    mockApi();
    const code = await runHosts(['login', '--token', 'kortix_pat_new', '--no-project']);
    expect(code).toBe(0);
    expect(requests).toEqual(['https://api.test/v1/accounts/me']);
    const host = getHost('test');
    expect(host?.token).toBe('kortix_pat_new');
    expect(host?.user_email).toBe('user@example.test');
    expect(stripAnsi(stdout)).toContain('Logged in to host test');
  });

  test('--help renders usage without touching the network', async () => {
    const code = await runHosts(['login', '--help']);
    expect(code).toBe(0);
    expect(requests).toEqual([]);
    expect(stripAnsi(stdout)).toContain('Usage: kortix hosts login');
  });

  test('an unknown <name> is registered and signed in (add + login)', async () => {
    mockApi();
    const code = await runHosts([
      'login',
      'fresh',
      '--token',
      'kortix_pat_new',
      '--api',
      'https://fresh.test',
      '--no-project',
    ]);
    expect(code).toBe(0);
    expect(requests).toEqual(['https://fresh.test/v1/accounts/me']);
    const host = getHost('fresh');
    expect(host?.url).toBe('https://fresh.test');
    expect(host?.token).toBe('kortix_pat_new');
    // Signing in a new host makes it active.
    expect(loadConfig().active).toBe('fresh');
  });

  test('rejects a token without the kortix_pat_ prefix', async () => {
    writeConfig('');
    mockApi();
    const code = await runHosts(['login', '--token', 'nope', '--no-project']);
    expect(code).toBe(1);
    expect(stripAnsi(stderr)).toContain('Invalid API key format');
  });

  test('the top-level `login` alias delegates identically to the active host', async () => {
    writeConfig('');
    mockApi();
    const code = await runLogin(['--token', 'kortix_pat_alias', '--no-project']);
    expect(code).toBe(0);
    expect(getHost('test')?.token).toBe('kortix_pat_alias');
  });
});

describe('kortix login — the account step of the funnel', () => {
  test('exactly one account is auto-selected (no prompt)', async () => {
    writeConfig('');
    mockApi([ACCOUNTS[0]]); // single account
    const code = await runHosts(['login', '--token', 'kortix_pat_new', '--no-project']);
    expect(code).toBe(0);
    expect(getHost('test')?.account_id).toBe('account_1');
    expect(stripAnsi(stdout)).toContain('Active account: Personal');
  });

  test('multiple accounts without a TTY keep the first (never blocks CI)', async () => {
    writeConfig('');
    mockApi(); // two accounts; test runner stdin is not a TTY
    const code = await runHosts(['login', '--token', 'kortix_pat_new', '--no-project']);
    expect(code).toBe(0);
    expect(getHost('test')?.account_id).toBe('account_1');
    // Non-TTY hint points the user at the switch verb.
    expect(stripAnsi(stdout)).toContain('kortix accounts use');
  });

  test('--account <slug> picks the active account non-interactively', async () => {
    writeConfig('');
    mockApi();
    const code = await runHosts([
      'login',
      '--token',
      'kortix_pat_new',
      '--account',
      'kortix',
      '--no-project',
    ]);
    expect(code).toBe(0);
    expect(getHost('test')?.account_id).toBe('account_2');
    expect(stripAnsi(stdout)).toContain('Active account: Kortix');
  });

  test('an unknown --account warns and falls back to the first account', async () => {
    writeConfig('');
    mockApi();
    const code = await runHosts([
      'login',
      '--token',
      'kortix_pat_new',
      '--account',
      'nope',
      '--no-project',
    ]);
    expect(code).toBe(0);
    expect(stripAnsi(stderr)).toContain('No account "nope"');
    expect(getHost('test')?.account_id).toBe('account_1');
  });

  test('the top-level `login --account` alias behaves identically', async () => {
    writeConfig('');
    mockApi();
    const code = await runLogin(['--token', 'kortix_pat_new', '--account', 'kortix', '--no-project']);
    expect(code).toBe(0);
    expect(getHost('test')?.account_id).toBe('account_2');
  });
});

describe('kortix hosts logout', () => {
  test('clears the active host token (default)', async () => {
    const code = await runHosts(['logout']);
    expect(code).toBe(0);
    // Built-in-less custom host is removed entirely; its record is gone.
    expect(getHost('test')).toBeNull();
    expect(stripAnsi(stdout)).toContain('Logged out of test');
  });

  test('clears a named host', async () => {
    // Give `cloud` a token, then log it out by name while `test` stays active.
    const cfgPath = process.env.KORTIX_CONFIG_FILE!;
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.hosts.cloud = {
      url: 'https://api.kortix.com',
      token: 'tok_cloud',
      user_id: 'u',
      user_email: 'c@example.test',
      account_id: 'a',
      logged_in_at: '2026-01-01T00:00:00.000Z',
    };
    writeFileSync(cfgPath, JSON.stringify(cfg), 'utf8');

    const code = await runHosts(['logout', 'cloud']);
    expect(code).toBe(0);
    // `cloud` is a built-in — it resets to an empty-token placeholder.
    expect(getHost('cloud')?.token).toBe('');
    // The active host is untouched.
    expect(getHost('test')?.token).toBe('tok_test');
  });

  test('the top-level `logout` alias delegates identically', async () => {
    const code = await runLogout([]);
    expect(code).toBe(0);
    expect(getHost('test')).toBeNull();
  });
});

describe('kortix hosts whoami', () => {
  test('prints the signed-in user for the active host (default)', async () => {
    mockApi();
    const code = await runHosts(['whoami']);
    expect(code).toBe(0);
    expect(requests).toEqual(['https://api.test/v1/accounts/me']);
    expect(stripAnsi(stdout)).toContain('user@example.test');
  });

  test('--json mirrors the top-level `whoami --json` alias', async () => {
    mockApi();
    const viaHosts = await runHosts(['whoami', '--json']);
    const hostsJson = JSON.parse(stdout);
    expect(viaHosts).toBe(0);

    stdout = '';
    requests = [];
    const viaAlias = await runWhoami(['--json']);
    const aliasJson = JSON.parse(stdout);
    expect(viaAlias).toBe(0);

    expect(hostsJson.user_email).toBe('user@example.test');
    expect(aliasJson.user_email).toBe(hostsJson.user_email);
    expect(aliasJson.user_id).toBe(hostsJson.user_id);
  });

  test('errors when the named host is not signed in', async () => {
    mockApi();
    const code = await runHosts(['whoami', 'selfhost']);
    expect(code).toBe(1);
    expect(stripAnsi(stderr)).toContain('not logged in');
    expect(stripAnsi(stderr)).toContain('kortix hosts login selfhost');
  });
});

describe('kortix hosts ls', () => {
  test('rows show signed-in vs not-signed-in status', async () => {
    const code = await runHosts(['ls']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    // The active, signed-in `test` host.
    expect(out).toMatch(/●\s+test\s+✓\s+user@example.test/);
    // A built-in host with no token reads as not signed in.
    expect(out).toContain('○ not signed in');
    expect(out).toContain('STATUS');
  });

  test('--json reports logged_in per host', async () => {
    const code = await runHosts(['ls', '--json']);
    expect(code).toBe(0);
    const rows = JSON.parse(stdout) as Array<{ name: string; logged_in: boolean }>;
    expect(rows.find((r) => r.name === 'test')?.logged_in).toBe(true);
    expect(rows.find((r) => r.name === 'selfhost')?.logged_in).toBe(false);
  });
});
