import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSecrets } from '../commands/secrets.ts';
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

/** Shared secret rows the mocked GET returns; mutate per-test. */
let secretItems: Array<{ identifier: string; name: string }>;
let manifestRequired: string[];
let manifestOptional: string[];

function secret(identifier: string, name = identifier) {
  return {
    identifier,
    name,
    secret_id: `sec_${identifier}`,
    project_id: 'proj_1',
    created_by: 'user_1',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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

    if (url.includes('/projects/proj_1/secrets') && method === 'GET') {
      return json({
        items: secretItems.map((s) => secret(s.identifier, s.name)),
        required: manifestRequired,
        optional: manifestOptional,
        can_manage: true,
        manifest_status: 'loaded',
        manifest_path: 'kortix.yaml',
      });
    }
    if (url.includes('/projects/proj_1/secrets') && method === 'POST') {
      const name = String(body.name).toUpperCase();
      const identifier = (body.identifier ?? name) as string;
      return json(secret(identifier, name));
    }
    if (url.includes('/projects/proj_1/secrets/') && method === 'DELETE') {
      return json({ status: 'deleted' });
    }
    return new Response(JSON.stringify({ error: `unexpected ${method} ${url}` }), { status: 500 });
  }) as typeof fetch;
}

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
  process.env.KORTIX_PROJECT_ID = 'proj_1';
  originalCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'kortix-secrets-test-'));
  process.chdir(tmp);
  writeConfig();
  captureOutput();
  requests = [];
  secretItems = [];
  manifestRequired = [];
  manifestOptional = [];
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

function posts() {
  return requests.filter((r) => r.method === 'POST');
}

describe('kortix secrets set — identifier', () => {
  test('KEY=VALUE with no identifier posts {name,value}, identifier defaults server-side', async () => {
    const code = await runSecrets(['set', 'STRIPE_API_KEY=sk_live_1']);
    expect(code).toBe(0);
    const [p] = posts();
    expect(p.body).toEqual({ name: 'STRIPE_API_KEY', value: 'sk_live_1' });
    expect('identifier' in p.body).toBe(false);
    expect(stripAnsi(stdout)).toContain('STRIPE_API_KEY');
  });

  test('lowercase key is uppercased before it is sent (web KEY_NAME parity)', async () => {
    const code = await runSecrets(['set', 'stripe_api_key=sk_live_1']);
    expect(code).toBe(0);
    expect(posts()[0].body.name).toBe('STRIPE_API_KEY');
  });

  test('--identifier stores a second value under the same key', async () => {
    const code = await runSecrets([
      'set',
      'GOOGLE_MAPS_API_KEY=backup_val',
      '--identifier',
      'GMAPS-backup',
    ]);
    expect(code).toBe(0);
    const [p] = posts();
    expect(p.body).toEqual({
      name: 'GOOGLE_MAPS_API_KEY',
      identifier: 'GMAPS-backup',
      value: 'backup_val',
    });
    const out = stripAnsi(stdout);
    expect(out).toContain('GMAPS-backup');
    expect(out).toContain('→ GOOGLE_MAPS_API_KEY');
  });

  test('--id is an accepted alias for --identifier', async () => {
    const code = await runSecrets(['set', 'GOOGLE_MAPS_API_KEY=v', '--id', 'GMAPS-primary']);
    expect(code).toBe(0);
    expect(posts()[0].body.identifier).toBe('GMAPS-primary');
  });

  test('--identifier with multiple pairs is rejected (addresses one secret)', async () => {
    const code = await runSecrets(['set', 'A=1', 'B=2', '--identifier', 'dup']);
    expect(code).toBe(2);
    expect(posts()).toHaveLength(0);
    expect(stripAnsi(stderr)).toContain('exactly one KEY=VALUE');
  });

  test('an invalid identifier is rejected before any network call', async () => {
    const code = await runSecrets(['set', 'A=1', '--identifier', 'bad id!']);
    expect(code).toBe(2);
    expect(requests).toHaveLength(0);
    expect(stripAnsi(stderr)).toContain('invalid identifier');
  });

  test('a malformed pair still fails with a KEY=VALUE hint', async () => {
    const code = await runSecrets(['set', 'NOTAPAIR']);
    expect(code).toBe(2);
    expect(stripAnsi(stderr)).toContain('expected KEY=VALUE');
  });
});

describe('kortix secrets ls — identifier-first', () => {
  test('lists a secret by identifier and shows → key when they differ', async () => {
    secretItems = [
      { identifier: 'GMAPS-primary', name: 'GOOGLE_MAPS_API_KEY' },
      { identifier: 'GMAPS-backup', name: 'GOOGLE_MAPS_API_KEY' },
    ];
    const code = await runSecrets(['ls']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('IDENTIFIER');
    expect(out).toContain('GMAPS-primary');
    expect(out).toContain('GMAPS-backup');
    // Two identifiers under one key are distinct rows, each hinting the key.
    expect(out.match(/→ GOOGLE_MAPS_API_KEY/g)?.length).toBe(2);
  });

  test('a required key with no secret shows as a missing row', async () => {
    manifestRequired = ['STRIPE_API_KEY'];
    const code = await runSecrets(['ls']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('STRIPE_API_KEY');
    expect(out).toContain('missing');
    expect(out).toContain('1 required secret missing');
  });

  test('--json emits identifier, key, has_value and source', async () => {
    secretItems = [{ identifier: 'GMAPS-backup', name: 'GOOGLE_MAPS_API_KEY' }];
    manifestRequired = ['STRIPE_API_KEY'];
    const code = await runSecrets(['ls', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    const backup = parsed.secrets.find((s: { identifier: string }) => s.identifier === 'GMAPS-backup');
    expect(backup).toEqual({
      identifier: 'GMAPS-backup',
      key: 'GOOGLE_MAPS_API_KEY',
      has_value: true,
      source: 'undeclared',
    });
    const stripe = parsed.secrets.find((s: { identifier: string }) => s.identifier === 'STRIPE_API_KEY');
    expect(stripe).toEqual({
      identifier: 'STRIPE_API_KEY',
      key: 'STRIPE_API_KEY',
      has_value: false,
      source: 'required',
    });
  });
});

describe('kortix secrets unset — by identifier', () => {
  test('deletes by identifier', async () => {
    const code = await runSecrets(['unset', 'GMAPS-backup']);
    expect(code).toBe(0);
    const del = requests.find((r) => r.method === 'DELETE');
    expect(del?.url).toContain('/secrets/GMAPS-backup');
  });
});
