import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runChannels } from '../commands/channels.ts';
import { stripAnsi } from '../style.ts';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_STDOUT_WRITE = process.stdout.write;
const ORIGINAL_STDERR_WRITE = process.stderr.write;

const ENV_KEYS = [
  'KORTIX_CLI_TOKEN',
  'KORTIX_EXECUTOR_TOKEN',
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_DISABLE_SANDBOX_ENV_FILE',
  'KORTIX_CONFIG_FILE',
  'KORTIX_AUTH_FILE',
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
] as const;

const INSTALL_URL = 'https://slack.com/oauth/v2/authorize?client_id=1.2&scope=chat:write&state=signed';
const INSTALLATION = {
  workspaceId: 'T012AB3CD',
  workspaceName: 'Acme',
  botUserId: 'U0BOT',
  installedAt: '2026-07-08T00:00:00.000Z',
};

let saved: Record<string, string | undefined>;
let tmp: string;
let originalCwd: string;
let stdout = '';
let stderr = '';
let requests: Array<{ url: string; method: string; body: any }> = [];

interface MockState {
  oauthAvailable: boolean;
  installation: typeof INSTALLATION | null;
  /** Return `installation` from the Nth GET /installation onwards (0-based). */
  installedAfterPolls?: number;
}

let state: MockState;
let installationGets = 0;

function writeConfig(): void {
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
      },
    }),
    'utf8',
  );
  process.env.KORTIX_CONFIG_FILE = file;
}

function captureOutput() {
  stdout = '';
  stderr = '';
  (process.stdout as any).write = (chunk: unknown) => ((stdout += String(chunk)), true);
  (process.stderr as any).write = (chunk: unknown) => ((stderr += String(chunk)), true);
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
}

function mockApi() {
  installationGets = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: any = undefined;
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    requests.push({ url, method, body });

    if (url.includes('/channels/slack/mode')) {
      return json({
        oauth_available: state.oauthAvailable,
        install_url: state.oauthAvailable ? INSTALL_URL : null,
      });
    }
    if (url.includes('/channels/slack/installation') && method === 'GET') {
      installationGets += 1;
      if (state.installedAfterPolls !== undefined && installationGets > state.installedAfterPolls) {
        return json(INSTALLATION);
      }
      return json(state.installation);
    }
    if (url.includes('/channels/slack/installation') && method === 'DELETE') {
      return json({ status: 'disconnected' });
    }
    if (url.includes('/channels/slack/connect') && method === 'POST') {
      return json(INSTALLATION);
    }
    return new Response(JSON.stringify({ error: `unexpected ${method} ${url}` }), { status: 500 });
  }) as typeof fetch;
}

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
  process.env.KORTIX_PROJECT_ID = 'proj_1';
  originalCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'kortix-channels-test-'));
  process.chdir(tmp);
  writeConfig();
  captureOutput();
  requests = [];
  state = { oauthAvailable: true, installation: null };
  mockApi();
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

describe('kortix channels connect — one-click (cloud)', () => {
  test('prints the install link when OAuth is configured and nothing is connected', async () => {
    const code = await runChannels(['connect']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('Add to Slack');
    expect(out).toContain(INSTALL_URL);
    expect(out).not.toContain('kortix channels manifest');
    expect(out).not.toContain('signing secret');
    expect(requests.some((r) => r.url.includes('/channels/slack/mode'))).toBe(true);
    expect(requests.some((r) => r.method === 'POST')).toBe(false);
  });

  test('--json emits install_url + connected:false for the agent to surface', async () => {
    const code = await runChannels(['connect', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.connected).toBe(false);
    expect(parsed.install_url).toBe(INSTALL_URL);
  });

  test('already connected → says so instead of pretending to reconnect', async () => {
    state.installation = INSTALLATION;
    const code = await runChannels(['connect']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('Already connected');
    expect(out).toContain('Acme');
  });

  test('--wait polls the installation until it lands', async () => {
    // First GET (pre-link existing check) returns null; the first poll connects.
    state.installedAfterPolls = 1;
    const code = await runChannels(['connect', '--wait', '--timeout', '30']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain(INSTALL_URL);
    expect(out).toContain('Connected to Acme');
  });
});

describe('kortix channels connect — manual (self-host)', () => {
  test('OAuth unavailable + no creds → exit 2 with the manual playbook, not a stack of API calls', async () => {
    state.oauthAvailable = false;
    const code = await runChannels(['connect']);
    expect(code).toBe(2);
    const err = stripAnsi(stderr);
    expect(err).toContain('kortix channels manifest');
    expect(err).toContain('--bot-token');
  });

  test('OAuth unavailable + env creds → posts them to /connect', async () => {
    state.oauthAvailable = false;
    process.env.SLACK_BOT_TOKEN = 'xoxb-123';
    process.env.SLACK_SIGNING_SECRET = 'sig-abc';
    const code = await runChannels(['connect']);
    expect(code).toBe(0);
    const post = requests.find((r) => r.method === 'POST' && r.url.includes('/channels/slack/connect'));
    expect(post).toBeDefined();
    expect(post!.body).toMatchObject({ bot_token: 'xoxb-123', signing_secret: 'sig-abc' });
    expect(stripAnsi(stdout)).toContain('Connected to Acme');
  });

  test('explicit --bot-token/--signing-secret skips the /mode lookup entirely', async () => {
    const code = await runChannels(['connect', '--bot-token', 'xoxb-456', '--signing-secret', 'sig-def']);
    expect(code).toBe(0);
    expect(requests.some((r) => r.url.includes('/channels/slack/mode'))).toBe(false);
    const post = requests.find((r) => r.method === 'POST');
    expect(post!.body).toMatchObject({ bot_token: 'xoxb-456', signing_secret: 'sig-def' });
  });

  test('--manual without creds never mints or prints an OAuth link', async () => {
    const code = await runChannels(['connect', '--manual']);
    expect(code).toBe(2);
    expect(requests.some((r) => r.url.includes('/channels/slack/mode'))).toBe(false);
    expect(stripAnsi(stdout)).not.toContain(INSTALL_URL);
  });

  test('bad bot token prefix is rejected client-side', async () => {
    const code = await runChannels(['connect', '--bot-token', 'xoxp-oops', '--signing-secret', 's']);
    expect(code).toBe(2);
    expect(stripAnsi(stderr)).toContain('xoxb-');
    expect(requests.some((r) => r.method === 'POST')).toBe(false);
  });
});

describe('kortix channels status', () => {
  test('not connected → points at `kortix channels connect`', async () => {
    const code = await runChannels(['status']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('not connected');
    expect(out).toContain('kortix channels connect');
  });

  test('--json reports connected + installation', async () => {
    state.installation = INSTALLATION;
    const code = await runChannels(['status', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.connected).toBe(true);
    expect(parsed.installation.workspaceId).toBe('T012AB3CD');
  });
});
