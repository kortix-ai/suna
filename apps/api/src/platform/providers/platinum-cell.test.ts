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
