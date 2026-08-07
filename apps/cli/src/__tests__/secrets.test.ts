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
type RequestBody = Record<string, unknown> | string | undefined;
let requests: Array<{ url: string; method: string; body: RequestBody }> = [];

/** Shared secret rows the mocked GET returns; mutate per-test. */
let secretItems: Array<{
  identifier: string;
  name: string;
  configured?: boolean;
  effective_source?: 'mine' | 'shared' | 'none';
  strategy?: 'runtime' | 'egress' | 'broker' | 'denied';
  consumer?:
    'sandbox' | 'llm_gateway' | 'connector' | 'git_proxy' | 'http_broker' | 'network' | null;
  delivery_status?: 'available' | 'unavailable' | 'disabled';
  requires_rotation?: boolean;
}>;
let manifestRequired: string[];
let manifestOptional: string[];
let syncResponse: Record<string, unknown>;

function secret(
  identifier: string,
  name = identifier,
  state: {
    configured?: boolean;
    effective_source?: 'mine' | 'shared' | 'none';
    strategy?: 'runtime' | 'egress' | 'broker' | 'denied';
    consumer?:
      'sandbox' | 'llm_gateway' | 'connector' | 'git_proxy' | 'http_broker' | 'network' | null;
    delivery_status?: 'available' | 'unavailable' | 'disabled';
    requires_rotation?: boolean;
  } = {},
) {
  const configured = state.configured ?? true;
  const effectiveSource = state.effective_source ?? (configured ? 'shared' : 'none');
  return {
    identifier,
    name,
    secret_id: `sec_${identifier}`,
    project_id: 'proj_1',
    created_by: 'user_1',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    configured,
    effective_source: effectiveSource,
    strategy: state.strategy ?? 'runtime',
    consumer: state.consumer ?? 'sandbox',
    delivery_status: state.delivery_status ?? 'available',
    requires_rotation: state.requires_rotation ?? false,
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
  const stdoutStream = process.stdout as unknown as { write: (chunk: unknown) => boolean };
  const stderrStream = process.stderr as unknown as { write: (chunk: unknown) => boolean };
  stdoutStream.write = (chunk: unknown) => {
    stdout += String(chunk);
    return true;
  };
  stderrStream.write = (chunk: unknown) => {
    stderr += String(chunk);
    return true;
  };
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
    let body: RequestBody = undefined;
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
        items: secretItems.map((s) => secret(s.identifier, s.name, s)),
        required: manifestRequired,
        optional: manifestOptional,
        can_manage: true,
        manifest_status: 'loaded',
        manifest_path: 'kortix.yaml',
      });
    }
    if (url.includes('/projects/proj_1/secrets/') && url.endsWith('/broker') && method === 'POST') {
      return json({
        status: 201,
        headers: { 'content-type': 'application/json' },
        body_base64: Buffer.from('{"created":true}').toString('base64'),
      });
    }
    if (url.endsWith('/projects/proj_1/secrets/sync') && method === 'POST') {
      return json(syncResponse);
    }
    if (url.includes('/projects/proj_1/secrets') && method === 'POST') {
      const input = typeof body === 'object' && body !== null ? body : {};
      const name = String(input.name).toUpperCase();
      const identifier = String(input.identifier ?? name);
      return json(secret(identifier, name));
    }
    if (
      url.includes('/projects/proj_1/secrets/') &&
      url.endsWith('/strategy') &&
      method === 'PUT'
    ) {
      const input = typeof body === 'object' && body !== null ? body : {};
      const identifier = decodeURIComponent(url.split('/secrets/')[1].split('/strategy')[0]);
      return json(
        secret(identifier, identifier, {
          strategy: input.strategy as 'runtime' | 'egress' | 'broker' | 'denied',
          consumer: input.strategy === 'runtime' ? 'sandbox' : null,
          delivery_status: input.strategy === 'denied' ? 'disabled' : 'available',
          requires_rotation: input.strategy !== 'runtime',
        }),
      );
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
  syncResponse = {
    ok: true,
    active_sandboxes: 1,
    targeted: 1,
    synced: 1,
    failed: 0,
    exported: 2,
    results: [{
      session_id: 'session-1',
      sandbox_id: 'sandbox-1',
      status: 'synced',
      scope: 'inherit',
      revision: 'revision-1',
      exported: 2,
      managed: 2,
      withheld: 0,
      agent_env_written: true,
    }],
  };
  mockApi();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  const stdoutStream = process.stdout as unknown as { write: (chunk: unknown) => boolean };
  const stderrStream = process.stderr as unknown as { write: (chunk: unknown) => boolean };
  stdoutStream.write = ORIGINAL_STDOUT_WRITE as unknown as (chunk: unknown) => boolean;
  stderrStream.write = ORIGINAL_STDERR_WRITE as unknown as (chunk: unknown) => boolean;
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

function objectBody(request: (typeof requests)[number]): Record<string, unknown> {
  expect(request.body).toBeObject();
  return request.body as Record<string, unknown>;
}

describe('kortix secrets set — identifier', () => {
  test('KEY=VALUE with no identifier posts {name,value}, identifier defaults server-side', async () => {
    const code = await runSecrets(['set', 'STRIPE_API_KEY=sk_live_1']);
    expect(code).toBe(0);
    const [p] = posts();
    expect(objectBody(p)).toEqual({ name: 'STRIPE_API_KEY', value: 'sk_live_1' });
    expect('identifier' in objectBody(p)).toBe(false);
    expect(stripAnsi(stdout)).toContain('STRIPE_API_KEY');
  });

  test('lowercase key is uppercased before it is sent (web KEY_NAME parity)', async () => {
    const code = await runSecrets(['set', 'stripe_api_key=sk_live_1']);
    expect(code).toBe(0);
    expect(objectBody(posts()[0]).name).toBe('STRIPE_API_KEY');
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
    expect(objectBody(p)).toEqual({
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
    expect(objectBody(posts()[0]).identifier).toBe('GMAPS-primary');
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

describe('kortix secrets sync — verified delivery', () => {
  test('reports verified exports instead of formatting a boolean as a count', async () => {
    const code = await runSecrets(['sync']);

    expect(code).toBe(0);
    expect(stripAnsi(stdout)).toContain('Verified 2 secret export(s) across 1/1 active sandbox(es).');
    expect(stripAnsi(stdout)).toContain('session-1: 2 exported');
    expect(stripAnsi(stdout)).toContain('revision revision-1');
    expect(stripAnsi(stdout)).not.toContain('Synced true secret(s)');
  });

  test('exits non-zero and prints the target reason when daemon proof fails', async () => {
    syncResponse = {
      ok: false,
      active_sandboxes: 1,
      targeted: 1,
      synced: 0,
      failed: 1,
      exported: 0,
      results: [{
        session_id: 'session-broken',
        sandbox_id: 'sandbox-broken',
        status: 'failed',
        scope: 'inherit',
        revision: 'revision-broken',
        exported: 0,
        managed: null,
        withheld: null,
        agent_env_written: false,
        reason: 'env sync did not confirm agent-env.sh write',
      }],
    };

    const code = await runSecrets(['sync']);

    expect(code).toBe(1);
    expect(stripAnsi(stderr)).toContain('Secret sync incomplete: 0 synced, 1 failed.');
    expect(stripAnsi(stderr)).toContain('env sync did not confirm agent-env.sh write');
    expect(stripAnsi(stdout)).toBe('');
  });

  test('states when a verified zero export is caused by the session scope', async () => {
    syncResponse = {
      ok: true,
      active_sandboxes: 1,
      targeted: 1,
      synced: 1,
      failed: 0,
      exported: 0,
      results: [{
        session_id: 'session-zero',
        sandbox_id: 'sandbox-zero',
        status: 'synced',
        scope: 'none',
        revision: 'revision-zero',
        exported: 0,
        managed: 54,
        withheld: 54,
        agent_env_written: true,
      }],
    };

    const code = await runSecrets(['sync']);

    expect(code).toBe(0);
    expect(stripAnsi(stdout)).toContain('0 exported · revision revision-zero · scope permits zero secrets');
  });

  test('states when no active sandbox needs synchronization', async () => {
    syncResponse = {
      ok: true,
      active_sandboxes: 0,
      targeted: 0,
      synced: 0,
      failed: 0,
      exported: 0,
      results: [],
    };

    const code = await runSecrets(['sync']);

    expect(code).toBe(0);
    expect(stripAnsi(stdout)).toContain('No active sandboxes require secret synchronization.');
    expect(stripAnsi(stdout)).not.toContain('Verified 0 secret export');
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

  test('--json exposes API names and explicit availability with compatibility aliases', async () => {
    secretItems = [{ identifier: 'GMAPS-backup', name: 'GOOGLE_MAPS_API_KEY' }];
    manifestRequired = ['STRIPE_API_KEY'];
    const code = await runSecrets(['ls', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    const backup = parsed.secrets.find(
      (s: { identifier: string }) => s.identifier === 'GMAPS-backup',
    );
    expect(backup).toEqual({
      identifier: 'GMAPS-backup',
      name: 'GOOGLE_MAPS_API_KEY',
      configured: true,
      available: true,
      effective_source: 'shared',
      strategy: 'runtime',
      consumer: 'sandbox',
      delivery_status: 'available',
      requires_rotation: false,
      key: 'GOOGLE_MAPS_API_KEY',
      has_value: true,
      source: 'undeclared',
    });
    const stripe = parsed.secrets.find(
      (s: { identifier: string }) => s.identifier === 'STRIPE_API_KEY',
    );
    expect(stripe).toEqual({
      identifier: 'STRIPE_API_KEY',
      name: 'STRIPE_API_KEY',
      configured: false,
      available: false,
      effective_source: 'none',
      strategy: 'runtime',
      consumer: 'sandbox',
      delivery_status: 'available',
      requires_rotation: false,
      key: 'STRIPE_API_KEY',
      has_value: false,
      source: 'required',
    });
  });

  test('shows where each secret is delivered', async () => {
    secretItems = [
      { identifier: 'LOCAL_KEY', name: 'LOCAL_KEY', strategy: 'runtime' },
      {
        identifier: 'DISABLED_KEY',
        name: 'DISABLED_KEY',
        strategy: 'denied',
        consumer: null,
        delivery_status: 'disabled',
        requires_rotation: true,
      },
    ];
    const code = await runSecrets(['ls']);
    expect(code).toBe(0);
    const out = stripAnsi(stdout);
    expect(out).toContain('DELIVERY');
    expect(out).toContain('sandbox');
    expect(out).toContain('disabled');
    expect(out).toContain('rotate');
  });

  test('does not report a value-less API row as set merely because the row exists', async () => {
    secretItems = [
      {
        identifier: 'EMPTY_SLOT',
        name: 'EMPTY_SLOT',
        configured: false,
        effective_source: 'none',
      },
    ];
    const code = await runSecrets(['ls', '--json']);
    expect(code).toBe(0);
    const [row] = JSON.parse(stdout).secrets;
    expect(row).toMatchObject({
      identifier: 'EMPTY_SLOT',
      configured: false,
      available: false,
      effective_source: 'none',
      has_value: false,
    });
  });

  test('distinguishes a personal effective value from a shared configured value', async () => {
    secretItems = [
      {
        identifier: 'PERSONAL_SLOT',
        name: 'PERSONAL_SLOT',
        configured: false,
        effective_source: 'mine',
      },
    ];
    const code = await runSecrets(['ls', '--json']);
    expect(code).toBe(0);
    const [row] = JSON.parse(stdout).secrets;
    expect(row).toMatchObject({
      configured: false,
      available: true,
      effective_source: 'mine',
      has_value: true,
    });
  });
});

describe('kortix secrets delivery', () => {
  test('changes a secret to denied delivery', async () => {
    const code = await runSecrets(['delivery', 'ANTHROPIC_API_KEY', 'denied']);
    expect(code).toBe(0);
    const put = requests.find((request) => request.method === 'PUT');
    expect(put?.url).toContain('/secrets/ANTHROPIC_API_KEY/strategy');
    expect(put?.body).toEqual({ strategy: 'denied' });
    expect(stripAnsi(stdout)).toContain('Stored but disabled');
  });

  test('rejects an unknown strategy before any network call', async () => {
    const code = await runSecrets(['delivery', 'ANTHROPIC_API_KEY', 'plaintext']);
    expect(code).toBe(2);
    expect(requests).toHaveLength(0);
    expect(stripAnsi(stderr)).toContain('runtime, broker, egress, or denied');
  });

  test('configures an HTTPS broker policy from explicit allow and injection flags', async () => {
    const code = await runSecrets([
      'delivery',
      'ANTHROPIC_API_KEY',
      'broker',
      '--allow-host',
      'api.anthropic.com',
      '--allow-host',
      '*.anthropic.com',
      '--allow-method',
      'POST',
      '--allow-path',
      '/v1/*',
      '--inject-header',
      'x-api-key',
      '--template',
      '{{secret}}',
      '--handle-prefix',
      'sk-ant-api03-',
    ]);

    expect(code).toBe(0);
    const put = requests.find((request) => request.method === 'PUT');
    expect(put?.body).toEqual({
      strategy: 'broker',
      consumer: 'http_broker',
      egress_policy: {
        backend: 'kortix_fetch',
        rules: [
          { host: 'api.anthropic.com', methods: ['POST'], path: '/v1/*' },
          { host: '*.anthropic.com', methods: ['POST'], path: '/v1/*' },
        ],
        inject: { kind: 'header', name: 'x-api-key', template: '{{secret}}' },
        on_no_match: 'deny',
        tls: 'terminate',
      },
      handle_prefix: 'sk-ant-api03-',
    });
  });

  test('configures an LLM gateway consumer without HTTP policy flags', async () => {
    const code = await runSecrets([
      'delivery',
      'ANTHROPIC_API_KEY',
      'broker',
      '--consumer',
      'llm-gateway',
    ]);

    expect(code).toBe(0);
    const put = requests.find((request) => request.method === 'PUT');
    expect(put?.body).toEqual({ strategy: 'broker', consumer: 'llm_gateway' });
  });

  test('configures a connector consumer without HTTP policy flags', async () => {
    const code = await runSecrets([
      'delivery',
      'CONNECTOR_API_KEY',
      'broker',
      '--consumer',
      'connector',
    ]);

    expect(code).toBe(0);
    const put = requests.find((request) => request.method === 'PUT');
    expect(put?.body).toEqual({ strategy: 'broker', consumer: 'connector' });
  });

  test('maps the legacy automation alias to the connector consumer', async () => {
    const code = await runSecrets([
      'delivery',
      'WEBHOOK_SIGNING_KEY',
      'broker',
      '--consumer',
      'automation',
    ]);

    expect(code).toBe(0);
    const put = requests.find((request) => request.method === 'PUT');
    expect(put?.body).toEqual({ strategy: 'broker', consumer: 'connector' });
  });

  test('rejects HTTP policy flags for the LLM gateway consumer', async () => {
    const code = await runSecrets([
      'delivery',
      'ANTHROPIC_API_KEY',
      'broker',
      '--consumer',
      'llm-gateway',
      '--allow-host',
      'api.anthropic.com',
    ]);

    expect(code).toBe(2);
    expect(requests).toHaveLength(0);
    expect(stripAnsi(stderr)).toContain('cannot be used');
  });

  test('requires an explicit host and one injection slot for broker delivery', async () => {
    const noHost = await runSecrets([
      'delivery',
      'ANTHROPIC_API_KEY',
      'broker',
      '--inject-header',
      'x-api-key',
    ]);
    expect(noHost).toBe(2);
    expect(stripAnsi(stderr)).toContain('--allow-host');
    expect(requests).toHaveLength(0);

    captureOutput();
    const conflicting = await runSecrets([
      'delivery',
      'ANTHROPIC_API_KEY',
      'broker',
      '--allow-host',
      'api.anthropic.com',
      '--inject-header',
      'x-api-key',
      '--inject-query',
      'key',
    ]);
    expect(conflicting).toBe(2);
    expect(stripAnsi(stderr)).toContain('one injection');
    expect(requests).toHaveLength(0);
  });

  test('rejects broker-only flags for runtime delivery', async () => {
    const code = await runSecrets([
      'delivery',
      'ANTHROPIC_API_KEY',
      'runtime',
      '--allow-host',
      'api.anthropic.com',
    ]);
    expect(code).toBe(2);
    expect(requests).toHaveLength(0);
    expect(stripAnsi(stderr)).toContain('only valid for broker');
  });
});

describe('kortix secrets call', () => {
  test('sends a broker request through the SDK and prints the decoded response', async () => {
    const code = await runSecrets([
      'call',
      'ANTHROPIC_API_KEY',
      'https://api.anthropic.com/v1/messages',
      '--method',
      'POST',
      '--header',
      'content-type: application/json',
      '--data',
      '{"model":"test"}',
    ]);

    expect(code).toBe(0);
    const request = requests.find((item) => item.url.endsWith('/broker'));
    expect(request?.body).toEqual({
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body_base64: Buffer.from('{"model":"test"}').toString('base64'),
    });
    expect(stripAnsi(stdout)).toContain('Upstream status: 201');
    expect(stripAnsi(stdout)).toContain('{"created":true}');
  });

  test('reads a request body from a file', async () => {
    const bodyFile = join(tmp, 'request.json');
    writeFileSync(bodyFile, '{"from":"file"}', 'utf8');

    const code = await runSecrets([
      'call',
      'SERVICE_KEY',
      'https://api.example.com/v1/items',
      '--method',
      'POST',
      '--data-file',
      bodyFile,
      '--json',
    ]);

    expect(code).toBe(0);
    const request = requests.find((item) => item.url.endsWith('/broker'));
    expect(objectBody(request!)).toMatchObject({
      body_base64: Buffer.from('{"from":"file"}').toString('base64'),
    });
    expect(JSON.parse(stdout)).toMatchObject({ status: 201 });
  });

  test('rejects invalid or ambiguous request options before a network call', async () => {
    const badMethod = await runSecrets([
      'call',
      'SERVICE_KEY',
      'https://api.example.com/v1/items',
      '--method',
      'TRACE',
    ]);
    expect(badMethod).toBe(2);
    expect(requests).toHaveLength(0);

    captureOutput();
    const duplicateBody = await runSecrets([
      'call',
      'SERVICE_KEY',
      'https://api.example.com/v1/items',
      '--data',
      '{}',
      '--data-file',
      join(tmp, 'unused.json'),
    ]);
    expect(duplicateBody).toBe(2);
    expect(stripAnsi(stderr)).toContain('one request body');
    expect(requests).toHaveLength(0);
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
