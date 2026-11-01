// A Files folder that Platinum cannot mount never stops a session box from
// starting. Prod 2026-11-01: one folder's sub_path image failed to derive
// ("scratch image over budget") and every create of every session that
// mounted it answered 503, for ~5 h. The session marks its folder mounts
// `optionalVolumes`; a create refused over a mount boots again without them
// (a new attempt, so a new name and Idempotency-Key), and the result names
// what it left out for the session to attach later. The harness below is
// platinum-region.test.ts's.
import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { platinumHttpError } from '../../__tests__/helpers/platinum-http-error';
mock.module('../sandbox-ownership', () => ({ sandboxOwnershipMarker: async () => 'v2-owner-a' }));

function setTestEnv(name: string, value: string): void {
  if (!process.env[name] || process.env[name]?.startsWith('encrypted:')) {
    process.env[name] = value;
  }
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

type Call = {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
};

let calls: Call[] = [];
// Scripted per-call-index responses/errors for the create POST — index() so
// a test can script "first call errors, second call succeeds" sequences.
let createSequence: Array<{ result?: Record<string, unknown>; error?: Error }> = [
  { result: { id: 'sbx_new', state: 'running' } },
];
let createCallCount = 0;
let nextSecretId = 1;

function normalizeHeaders(h: RequestInit['headers']): Record<string, string> {
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries(h.entries());
  if (Array.isArray(h)) return Object.fromEntries(h as [string, string][]);
  return { ...(h as Record<string, string>) };
}

mock.module('../../shared/platinum', () => ({
  isPlatinumConfigured: () => true,
  platinumJsonResponse: async () => {
    throw new Error('unexpected Platinum materialization request');
  },
  platinumJson: async (path: string, init: RequestInit = {}) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const headers = normalizeHeaders(init.headers);
    calls.push({ path, method: String(init.method ?? 'GET'), headers, body });
    if (path.startsWith('/v1/secrets?')) return { items: [], cursor: null };
    if (path === '/v1/secrets' && String(init.method ?? 'GET') === 'POST') {
      return { id: `sec_${nextSecretId++}`, ...body };
    }
    if (path.startsWith('/v1/sandboxes?')) {
      const idx = Math.min(createCallCount, createSequence.length - 1);
      createCallCount += 1;
      const scripted = createSequence[idx];
      if (scripted.error) throw scripted.error;
      return scripted.result;
    }
    if (path.includes('/expose')) return { url: 'https://sbx.test/agent', port: 8000, public: true };
    return {};
  },
}));
mock.module('../service-key', () => ({ serviceKeyForExternalId: () => 'svc_key' }));
mock.module('../sandbox-frontend-url', () => ({ sandboxFrontendBaseUrl: () => 'https://app.example.com' }));

const { PlatinumProvider } = await import('./platinum');
const { logger } = await import('../../lib/logger');
await import('../services/session-sandbox');

const SANDBOX_ID = '11111111-2222-4333-8444-555555555555';

const baseOpts = {
  accountId: 'acc_1',
  userId: 'usr_1',
  // The truncated display name session-sandbox.ts actually sends as `name` —
  // the dedup identity must NEVER be derived from this.
  name: 'session-11111111',
  envVars: { KORTIX_TOKEN: 'tok_test' },
  sandboxId: SANDBOX_ID,
};


function createCalls() {
  return calls.filter((c) => c.path.startsWith('/v1/sandboxes?') && c.method === 'POST');
}

beforeEach(() => {
  calls = [];
  createCallCount = 0;
  nextSecretId = 1;
  createSequence = [{ result: { id: 'sbx_new', state: 'running' } }];
  delete process.env.KORTIX_PLATINUM_CREATE_DEDUP;
});

const CREATE = 'platinum POST /v1/sandboxes?wait_for_state=running&wait_timeout_ms=60000 -> ';
const refusal = (status: number, body: Record<string, unknown>) => platinumHttpError(`${CREATE}${status} ${JSON.stringify(body)}`);

const workspace = { '/workspace': { volume: 'kws-11111111-2222-4333-8444-555555555555' } };
const company = { '/drives/company': { volume: 'kd-0a1b2c3d4e5f60718293', subdir: '/Company', share: 'node' as const } };
const volumes = { ...workspace, ...company };

const mountRefusals: Record<string, Error> = {
  // The prod error of 2026-11-01, verbatim apart from the file path.
  'sub_path derivation failed': refusal(503, {
    error: 'deriving the sub_path image failed: volgw: subimage Video/clip.wav: volimg: scratch image over budget',
    code: 'unavailable',
  }),
  'sub_path still being derived': refusal(503, { error: 'the sub_path image is still being derived; retry shortly', code: 'unavailable', retry_after: 2 }),
  sub_path_too_large: refusal(422, { error: 'the subdir is larger than a sub_path mount allows', code: 'sub_path_too_large', bytes: 12, max_bytes: 10 }),
  sub_path_not_found: refusal(404, { error: 'sub_path /Company not found', code: 'sub_path_not_found' }),
  volume_busy: refusal(409, { error: 'volume is busy', code: 'volume_busy' }),
  // Real Platinum answer (local stack, 2026-11-01): the body names only the folder.
  not_a_directory: refusal(409, { error: '/Company exists and is not a directory', code: 'not_a_directory', path: '/Company' }),
  'an unknown code naming the folder': refusal(409, { error: '/Company cannot be mounted here', code: 'conflict' }),
};

describe('optional volumes: a mount Platinum refuses never stops the box', () => {
  for (const [name, refused] of Object.entries(mountRefusals)) {
    test(`${name} ⇒ the box boots without its folder, on a new attempt`, async () => {
      createSequence = [{ error: refused }, { result: { id: 'sbx_ok', state: 'running' } }];
      const warn = spyOn(logger, 'warn').mockImplementation(() => {});
      const p = new PlatinumProvider();
      const result = await p.create({ ...baseOpts, createAttempt: 3, volumes, optionalVolumes: ['/drives/company'] });
      warn.mockRestore();

      const [first, second] = createCalls();
      expect(createCalls()).toHaveLength(2);
      expect(first.body?.volumes).toEqual(volumes);
      expect(second.body?.volumes).toEqual(workspace);
      expect(second.headers['Idempotency-Key']).not.toBe(first.headers['Idempotency-Key']);
      expect(second.body?.name).not.toBe(first.body?.name);
      expect(result.externalId).toBe('sbx_ok');
      expect(result.metadata?.platinumCreateAttempt).toBe(4);
      const http = refused as Error & { status: number; code?: string };
      expect(result.metadata?.droppedVolumes).toEqual([
        { mountPath: '/drives/company', status: http.status, code: http.code ?? null, reason: expect.any(String) },
      ]);
    });
  }

  test('the box keeps every required volume, and a box with only optional ones sends no volumes', async () => {
    createSequence = [{ error: mountRefusals.sub_path_too_large }, { result: { id: 'sbx_ok', state: 'running' } }];
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    const p = new PlatinumProvider();
    const result = await p.create({ ...baseOpts, createAttempt: 1, volumes: company, optionalVolumes: ['/drives/company'] });
    warn.mockRestore();

    const second = createCalls()[1];
    expect(second.body && 'volumes' in second.body).toBe(false);
    expect(result.metadata?.droppedVolumes).toHaveLength(1);
  });

  test('a required volume refused on the second create still fails loudly, after exactly two creates', async () => {
    createSequence = [{ error: mountRefusals['sub_path derivation failed'] }, { error: refusal(404, { error: 'volume kws-x not found', code: 'volume_not_found' }) }];
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    const p = new PlatinumProvider();
    const err = await p.create({ ...baseOpts, createAttempt: 1, volumes, optionalVolumes: ['/drives/company'] }).catch((e) => e);
    warn.mockRestore();

    expect(createCalls()).toHaveLength(2);
    expect((err as Error).message).toContain('[workspace]');
  });

  test('a refusal that names one folder drops only that folder; a second refusal drops the next', async () => {
    const notes = { '/drives/notes': { volume: 'kd-0a1b2c3d4e5f60718293', subdir: '/Notes', share: 'node' as const } };
    const docs = { '/drives/blob-txt': { volume: 'kd-0a1b2c3d4e5f60718293', subdir: '/Docs/blob.txt', share: 'node' as const } };
    createSequence = [
      // Real Platinum answer (local stack, 2026-11-01).
      { error: refusal(409, { error: '/Docs/blob.txt exists and is not a directory', code: 'not_a_directory', path: '/Docs/blob.txt' }) },
      { error: refusal(404, { error: 'sub_path /Notes not found', code: 'sub_path_not_found' }) },
      { result: { id: 'sbx_ok', state: 'running' } },
    ];
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    const p = new PlatinumProvider();
    const result = await p.create({
      ...baseOpts,
      createAttempt: 1,
      volumes: { ...workspace, ...company, ...notes, ...docs },
      optionalVolumes: ['/drives/company', '/drives/notes', '/drives/blob-txt'],
    });
    warn.mockRestore();

    const [, second, third] = createCalls();
    expect(createCalls()).toHaveLength(3);
    expect(Object.keys(second.body?.volumes as object).sort()).toEqual(['/drives/company', '/drives/notes', '/workspace']);
    expect(Object.keys(third.body?.volumes as object).sort()).toEqual(['/drives/company', '/workspace']);
    expect(result.metadata?.platinumCreateAttempt).toBe(3);
    expect((result.metadata?.droppedVolumes as Array<{ mountPath: string; code: string }>).map((d) => [d.mountPath, d.code])).toEqual([
      ['/drives/blob-txt', 'not_a_directory'],
      ['/drives/notes', 'sub_path_not_found'],
    ]);
  });

  test('a full fleet is not a mount refusal: nothing is dropped', async () => {
    const full = refusal(503, { error: 'no capacity for a sandbox mounting volume kd-x', code: 'unavailable' });
    createSequence = [{ error: full }];
    const p = new PlatinumProvider();
    const err = await p.create({ ...baseOpts, createAttempt: 1, volumes, optionalVolumes: ['/drives/company'] }).catch((e) => e);

    expect(createCalls()).toHaveLength(1);
    expect(err).toBe(full);
  });

  test('without optionalVolumes the sub_path refusal names the drives instead of a generic provider error', async () => {
    createSequence = [{ error: mountRefusals['sub_path derivation failed'] }];
    const p = new PlatinumProvider();
    const err = await p.create({ ...baseOpts, createAttempt: 1, volumes: company }).catch((e) => e);

    expect(createCalls()).toHaveLength(1);
    expect((err as Error).message).toContain('[drives]');
    expect((err as Error).message).toContain('scratch image over budget');
  });
});
