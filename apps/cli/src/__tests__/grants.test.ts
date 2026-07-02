import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runGrants } from '../commands/grants.ts';
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
] as const;

let saved: Record<string, string | undefined>;
let tmp: string;
let originalCwd: string;
let stdout = '';
let stderr = '';
let requests: Array<{ url: string; method: string; body: any }> = [];

const PROJECT = 'proj-1';
const GROUP_UUID = '11111111-2222-3333-4444-555555555555';

const RESOURCES = {
  agents: [
    {
      id: 'support-bot',
      name: 'support-bot',
      declares: { secrets: ['DB_URL'], connectors: 'all' },
    },
  ],
  skills: [{ id: 'triage', name: 'triage' }],
  secrets: [{ id: 'DB_URL', name: 'DB_URL' }],
};

const GRANTS = [
  {
    grant_id: 'grant_1',
    resource_type: 'agent',
    resource_id: 'support-bot',
    principal_type: 'member',
    principal_id: 'user-9',
    principal_label: 'alice@corp.com',
    granted_by: 'user_1',
    created_at: '2026-01-01T00:00:00.000Z',
    expires_at: null,
    orphaned: false,
  },
];

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

function mockApi() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: any = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    requests.push({ url, method, body });

    const has = (p: string) => url.includes(p);
    if (has('/resource-grants/') && method === 'DELETE') return json({ ok: true });
    if (has('/resource-grants') && method === 'POST') {
      return json({
        grant_id: 'grant_new',
        resource_type: body?.resource_type,
        resource_id: body?.resource_id,
        principal_type: body?.principal_type,
        principal_id: body?.principal_id,
      });
    }
    if (has('/resource-grants')) return json({ resources: RESOURCES, grants: GRANTS });
    if (has('/access'))
      return json({ members: [{ user_id: 'user-9', email: 'alice@corp.com' }], can_manage: true });
    return new Response(JSON.stringify({ error: `unexpected ${method} ${url}` }), { status: 500 });
  }) as typeof fetch;
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
  originalCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'kortix-grants-test-'));
  process.chdir(tmp);
  writeConfig();
  captureOutput();
  requests = [];
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

describe('kortix grants', () => {
  test('ls prints grantable agents (with declared scope) + existing grants', async () => {
    const code = await runGrants(['ls', '--project', PROJECT]);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('support-bot');
    expect(out).toContain('1 secret');
    expect(out).toContain('all connectors');
    // existing grant renders resource → principal label
    expect(out).toContain('alice@corp.com');
    expect(out).toContain('grant_1');
  });

  test('ls --json emits the raw payload', async () => {
    const code = await runGrants(['ls', '--project', PROJECT, '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.resources.agents[0].name).toBe('support-bot');
    expect(parsed.grants).toHaveLength(1);
  });

  test('assign resolves a member email → user-id and POSTs an agent grant', async () => {
    const code = await runGrants([
      'assign',
      'support-bot',
      '--to',
      'alice@corp.com',
      '--project',
      PROJECT,
    ]);
    expect(code).toBe(0);
    const post = requests.find((r) => r.method === 'POST');
    expect(post).toBeDefined();
    expect(post?.body).toMatchObject({
      resource_type: 'agent',
      resource_id: 'support-bot',
      principal_type: 'member',
      principal_id: 'user-9',
    });
    expect(stripAnsi(stdout)).toContain('inherit every secret + connector');
  });

  test('assign --group POSTs a group grant with the raw id', async () => {
    const code = await runGrants([
      'assign',
      'support-bot',
      '--to',
      GROUP_UUID,
      '--group',
      '--project',
      PROJECT,
    ]);
    expect(code).toBe(0);
    const post = requests.find((r) => r.method === 'POST');
    expect(post?.body).toMatchObject({
      principal_type: 'group',
      principal_id: GROUP_UUID,
    });
  });

  test('assign --type secret POSTs a secret grant', async () => {
    const code = await runGrants([
      'assign',
      'DB_URL',
      '--type',
      'secret',
      '--to',
      'alice@corp.com',
      '--project',
      PROJECT,
    ]);
    expect(code).toBe(0);
    const post = requests.find((r) => r.method === 'POST');
    expect(post?.body).toMatchObject({ resource_type: 'secret', resource_id: 'DB_URL' });
  });

  test('assign without --to fails with exit 2 and no request', async () => {
    const code = await runGrants(['assign', 'support-bot', '--project', PROJECT]);
    expect(code).toBe(2);
    expect(requests.find((r) => r.method === 'POST')).toBeUndefined();
    expect(stripAnsi(stderr)).toContain('--to');
  });

  test('assign --group with a non-uuid id is rejected before any request', async () => {
    const code = await runGrants([
      'assign',
      'support-bot',
      '--to',
      'not-a-uuid',
      '--group',
      '--project',
      PROJECT,
    ]);
    expect(code).toBe(2);
    expect(requests.find((r) => r.method === 'POST')).toBeUndefined();
  });

  test('revoke DELETEs the grant by id', async () => {
    const code = await runGrants(['revoke', 'grant_1', '--project', PROJECT]);
    expect(code).toBe(0);
    const del = requests.find((r) => r.method === 'DELETE');
    expect(del?.url).toContain('/resource-grants/grant_1');
  });
});
