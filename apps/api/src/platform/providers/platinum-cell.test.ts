// A session that runs as a pi cell (apps/pi-worker-js) is a Platinum
// `runtime: cell` sandbox: celld in the `pt-celld` template serves the
// configured worker's active version. The create differs from a microVM's in
// exactly the fields below, and each one has broken a real boot before:
//
//  - a cell without `worker` is refused by Platinum as malformed;
//  - an unprefixed variable reaches the celld node, never the isolate, so the
//    agent boots with no session, no token and no gateway;
//  - celld listens on 8080 unless told otherwise, and the API reaches every
//    session's daemon on 8000.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
mock.module('../sandbox-ownership', () => ({ sandboxOwnershipMarker: async () => 'v2-owner-a' }));

function setTestEnv(name: string, value: string): void {
  if (!process.env[name] || process.env[name]?.startsWith('encrypted:')) process.env[name] = value;
}
setTestEnv('DATABASE_URL', 'postgres://postgres:postgres@127.0.0.1:54322/postgres');
setTestEnv('SUPABASE_URL', 'http://127.0.0.1:54321');
setTestEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role');
setTestEnv('API_KEY_SECRET', 'test-api-key-secret');
setTestEnv('TUNNEL_SIGNING_SECRET', 'test-tunnel-signing-secret');
setTestEnv('ALLOWED_SANDBOX_PROVIDERS', 'platinum');
setTestEnv('KORTIX_URL', 'https://api.example.com');
setTestEnv('FRONTEND_URL', 'http://localhost:3000');
setTestEnv('INTERNAL_KORTIX_ENV', 'dev');
setTestEnv('RECALL_BASE_URL', 'https://us-west-2.recall.ai/api/v1');
setTestEnv('PLATINUM_API_URL', 'https://api.platinum.dev');
setTestEnv('PLATINUM_API_KEY', 'pt_test_key');
setTestEnv('PLATINUM_TEMPLATE', 'tpl_default');

type Call = { path: string; method: string; body: Record<string, unknown> | undefined };
let calls: Call[] = [];
let execAnswer: 'ok' | 'cell' | 'error' = 'ok';

mock.module('../../shared/platinum', () => ({
  isPlatinumConfigured: () => true,
  platinumJsonResponse: async () => {
    throw new Error('unexpected Platinum materialization request');
  },
  platinumJson: async (path: string, init: RequestInit = {}) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ path, method: String(init.method ?? 'GET'), body });
    if (path.startsWith('/v1/sandboxes?')) return { id: 'sbx_cell', state: 'running' };
    if (path.includes('/expose')) return { url: 'https://8000-sbx.test/?t=tok', token: 'tok', port: 8000, public: false };
    if (path.endsWith('/exec')) {
      if (execAnswer === 'cell') {
        throw new Error(`platinum POST ${path} -> 501 {"error":"runtime 'cell' (Durable cell) does not support running a command","code":"runtime_capability_unsupported","runtime":"cell","capability":"exec"}`);
      }
      if (execAnswer === 'error') throw new Error(`platinum POST ${path} -> 500 {"error":"boom"}`);
      return { result: { exit_code: 0, stdout: '', stderr: '' } };
    }
    return {};
  },
}));
mock.module('../service-key', () => ({ serviceKeyForExternalId: () => 'svc_key' }));
mock.module('../sandbox-frontend-url', () => ({ sandboxFrontendBaseUrl: () => 'https://app.example.com' }));

const { PlatinumProvider, buildCellCreateBody } = await import('./platinum');

const opts = {
  accountId: 'acc_1',
  userId: 'usr_1',
  name: 'session-11111111',
  sandboxId: '11111111-2222-4333-8444-555555555555',
  createAttempt: 1,
  snapshot: 'pt-celld',
  envVars: { KORTIX_TOKEN: 'tok_test', KORTIX_SESSION_ID: '11111111-2222-4333-8444-555555555555', KORTIX_LLM_BASE_URL: 'https://api.example.com/v1/llm' },
};

const createBody = () => calls.find((c) => c.path.startsWith('/v1/sandboxes?') && c.method === 'POST')?.body ?? {};

beforeEach(() => {
  calls = [];
  execAnswer = 'ok';
});

describe('a pi cell create', () => {
  test('names the cell runtime, the template and the worker', async () => {
    await new PlatinumProvider().create({ ...opts, cell: { worker: 'kortix-pi-cell' } });
    const body = createBody();
    expect(body.runtime).toBe('cell');
    expect(body.template).toBe('pt-celld');
    expect(body.worker).toBe('kortix-pi-cell');
  });

  test('every session variable reaches the isolate as CELLD_VAR_, and none goes in the microVM env', async () => {
    await new PlatinumProvider().create({ ...opts, cell: { worker: 'kortix-pi-cell' } });
    const body = createBody();
    const env = body.env as Record<string, string>;
    expect(env.CELLD_VAR_KORTIX_TOKEN).toBe('tok_test');
    expect(env.CELLD_VAR_KORTIX_SESSION_ID).toBe(opts.sandboxId);
    expect(env.CELLD_VAR_KORTIX_LLM_BASE_URL).toBe('https://api.example.com/v1/llm');
    // The provider's own callback env is the session's too.
    expect(env.CELLD_VAR_KORTIX_API_URL).toBe('https://api.example.com/v1');
    expect(Object.keys(env).filter((k) => !k.startsWith('CELLD_VAR_'))).toEqual(['CELLD_BASE_PORT']);
    expect(body.envVars).toBeUndefined();
  });

  test('a cell reserves 1 GB and 1 CPU, not the 4 GB celld template default: five cells filled a 25 GB host', async () => {
    await new PlatinumProvider().create({ ...opts, cell: { worker: 'kortix-pi-cell' } });
    const body = createBody();
    expect(body.ram_mb).toBe(1024);
    expect(body.cpu).toBe(1);
  });

  test('celld listens on the agent port, which is exposed privately', async () => {
    await new PlatinumProvider().create({ ...opts, cell: { worker: 'kortix-pi-cell' } });
    const body = createBody();
    expect((body.env as Record<string, string>).CELLD_BASE_PORT).toBe('8000');
    expect(body.expose).toEqual([{ port: 8000, public: false }]);
  });

  test('keeps the dedup name, the idle policy and the ownership marker, and marks the runtime', async () => {
    await new PlatinumProvider().create({ ...opts, cell: { worker: 'kortix-pi-cell' } });
    const body = createBody();
    expect(body.name).toBe(`kortix-${opts.sandboxId}-a1`);
    expect(body.auto_resume).toBe(false);
    expect(typeof body.auto_stop_minutes).toBe('number');
    expect((body.metadata as Record<string, unknown>)['kortix.managed']).toBe('v2-owner-a');
    expect((body.metadata as Record<string, unknown>)['kortix.runtime']).toBe('cell');
  });

  test('a session that is not a cell is created exactly as before', async () => {
    await new PlatinumProvider().create({ ...opts, snapshot: 'tpl_project' });
    const body = createBody();
    expect(body.runtime).toBeUndefined();
    expect(body.worker).toBeUndefined();
    expect((body.envVars as Record<string, string>).KORTIX_TOKEN).toBe('tok_test');
    expect(body.env).toBeUndefined();
  });

  test('buildCellCreateBody stringifies values and never carries the microVM env through', () => {
    const body = buildCellCreateBody({
      template: 'pt-celld',
      worker: 'w',
      envVars: { PORT: 8080 as unknown as string },
      base: { envVars: { SECRET: 'x' }, type: 'ephemeral', metadata: { a: 1 } },
    });
    expect((body.env as Record<string, string>).CELLD_VAR_PORT).toBe('8080');
    expect(body.envVars).toBeUndefined();
    expect(body.type).toBe('ephemeral');
    expect(body.metadata).toEqual({ a: 1, 'kortix.runtime': 'cell' });
  });
});

// A cell refuses `exec` (501 runtime_capability_unsupported), and exec is how
// Platinum renewal resets the idle timer. Preview-URL traffic is the other
// thing Platinum counts as activity (sandboxProxy touchActivity), so a cell is
// renewed with one authenticated GET through its private agent port.
describe('renewing a cell', () => {
  test('falls back from exec to a GET on the cell\'s private preview URL, with its token', async () => {
    execAnswer = 'cell';
    const seen: Array<{ url: string; token: string | null }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), token: new Headers(init?.headers).get('x-pt-preview-token') });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await new PlatinumProvider().renewLifecycle('sbx_cell');
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen).toEqual([{ url: 'https://8000-sbx.test/health', token: 'tok' }]);
  });

  test('a cell whose preview URL does not answer 200 is a failed renewal', async () => {
    execAnswer = 'cell';
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('down', { status: 502 })) as unknown as typeof fetch;
    try {
      await expect(new PlatinumProvider().renewLifecycle('sbx_cell')).rejects.toThrow(/502/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('any other exec failure still fails the renewal: only the cell refusal falls back', async () => {
    execAnswer = 'error';
    await expect(new PlatinumProvider().renewLifecycle('sbx_vm')).rejects.toThrow(/500/);
  });
});
