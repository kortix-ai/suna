// S1: idempotent Platinum sandbox creation via a deterministic Idempotency-Key
// (primary) + deterministic name (secondary/backstop). Platinum's CP
// implements Idempotency-Key (8-255 chars, scoped per actor+key): the SAME
// key with a semantically-identical body replays the already-committed
// sandbox instead of creating a second one, so a retry after an AMBIGUOUS
// transport failure (timeout / dropped response) never double-creates a VM
// + its billing stream. The CP also enforces per-org sandbox NAME
// uniqueness (409 name_taken) as a human-debuggable backstop layer.
//
// Both the key and the name are derived from the FULL 36-char
// session_sandboxes.sandboxId — NEVER opts.name (session-sandbox.ts's
// truncated `session-<8 chars>` display name) — plus a monotonic `attempt`
// counter threaded in via opts.createAttempt (see restorePlatinumCreateAttempt
// in session-sandbox.ts for the persistence/restore side of that counter).
import { beforeEach, describe, expect, mock, test } from 'bun:test';

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

function normalizeHeaders(h: RequestInit['headers']): Record<string, string> {
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries(h.entries());
  if (Array.isArray(h)) return Object.fromEntries(h as [string, string][]);
  return { ...(h as Record<string, string>) };
}

mock.module('../../shared/platinum', () => ({
  isPlatinumConfigured: () => true,
  platinumJson: async (path: string, init: RequestInit = {}) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const headers = normalizeHeaders(init.headers);
    calls.push({ path, method: String(init.method ?? 'GET'), headers, body });
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
const { restorePlatinumCreateAttempt } = await import('../services/session-sandbox');

const SANDBOX_ID = '11111111-2222-4333-8444-555555555555';

const baseOpts = {
  accountId: 'acc_1',
  userId: 'usr_1',
  // The truncated display name session-sandbox.ts actually sends as `name` —
  // the dedup identity must NEVER be derived from this.
  name: 'session-11111111',
  envVars: { KORTIX_SANDBOX_TOKEN: 'tok_test' },
  sandboxId: SANDBOX_ID,
};

function createCalls() {
  return calls.filter((c) => c.path.startsWith('/v1/sandboxes?') && c.method === 'POST');
}

beforeEach(() => {
  calls = [];
  createCallCount = 0;
  createSequence = [{ result: { id: 'sbx_new', state: 'running' } }];
  delete process.env.KORTIX_PLATINUM_CREATE_DEDUP;
});

describe('S1 deterministic name + Idempotency-Key derivation', () => {
  test('both derive from the FULL sandboxId, never opts.name / an 8-char truncation', async () => {
    const p = new PlatinumProvider();
    await p.create({ ...baseOpts, createAttempt: 1 });

    const create = createCalls()[0];
    expect(create.body?.name).toBe(`kortix-${SANDBOX_ID}-a1`);
    expect(String(create.body?.name)).not.toContain('session-11111111');
    expect(create.headers['Idempotency-Key']).toMatch(/^[0-9a-f]{64}$/);
  });

  test('the key is STABLE across the SAME attempt but CHANGES when attempt advances', async () => {
    const p = new PlatinumProvider();
    await p.create({ ...baseOpts, createAttempt: 1 });
    await p.create({ ...baseOpts, createAttempt: 1 });
    await p.create({ ...baseOpts, createAttempt: 2 });

    const posts = createCalls();
    expect(posts).toHaveLength(3);
    expect(posts[0].headers['Idempotency-Key']).toBe(posts[1].headers['Idempotency-Key']);
    expect(posts[0].body?.name).toBe(posts[1].body?.name);
    expect(posts[2].headers['Idempotency-Key']).not.toBe(posts[0].headers['Idempotency-Key']);
    expect(posts[2].body?.name).not.toBe(posts[0].body?.name);
    expect(posts[2].body?.name).toBe(`kortix-${SANDBOX_ID}-a2`);
  });

  test('the key changes when the template changes (different template = different create identity)', async () => {
    const p = new PlatinumProvider();
    await p.create({ ...baseOpts, snapshot: 'tpl_a', createAttempt: 1 });
    await p.create({ ...baseOpts, snapshot: 'tpl_b', createAttempt: 1 });

    const posts = createCalls();
    expect(posts[0].headers['Idempotency-Key']).not.toBe(posts[1].headers['Idempotency-Key']);
  });

  test('body values are semantically identical across a same-attempt retry (no accidental 422 idempotency_key_reused)', async () => {
    const p = new PlatinumProvider();
    await p.create({ ...baseOpts, createAttempt: 1 });
    await p.create({ ...baseOpts, createAttempt: 1 });

    const [first, second] = createCalls();
    expect(second.body).toEqual(first.body);
  });
});

describe('S1 ambiguous-retry / replay handling', () => {
  test('a same-attempt retry after an ambiguous timeout replays the SAME committed box (no second box)', async () => {
    // Model retrySandboxProvisionCreate's own retry: the FIRST create() call
    // times out (ambiguous — Kortix doesn't know if Platinum committed it),
    // the caller (session-sandbox.ts) retries with the SAME createAttempt,
    // and the CP's Idempotency-Key replay returns the ALREADY-committed box.
    createSequence = [
      { error: new Error('platinum POST /v1/sandboxes?wait_for_state=running timed out after 70000ms (caller-provided budget)') },
      { result: { id: 'sbx_committed', state: 'running', replayed: true } },
    ];
    const p = new PlatinumProvider();

    await expect(p.create({ ...baseOpts, createAttempt: 1 })).rejects.toThrow(/timed out/);
    const res = await p.create({ ...baseOpts, createAttempt: 1 });

    expect(res.externalId).toBe('sbx_committed');
    const posts = createCalls();
    expect(posts).toHaveLength(2);
    expect(posts[0].headers['Idempotency-Key']).toBe(posts[1].headers['Idempotency-Key']);
    expect(posts[0].body?.name).toBe(posts[1].body?.name);
  });

  test('an unexpected 409 name_taken re-issues the SAME body+key once and adopts the replayed box (no list/GET call)', async () => {
    createSequence = [
      { error: new Error('platinum POST /v1/sandboxes?wait_for_state=running -> 409 {"code":"name_taken","error":"name already taken"}') },
      { result: { id: 'sbx_committed', state: 'running', replayed: true } },
    ];
    const p = new PlatinumProvider();

    const res = await p.create({ ...baseOpts, createAttempt: 1 });

    expect(res.externalId).toBe('sbx_committed');
    const posts = createCalls();
    expect(posts).toHaveLength(2);
    expect(posts[0].headers['Idempotency-Key']).toBe(posts[1].headers['Idempotency-Key']);
    expect(posts[0].body).toEqual(posts[1].body);
    // No GET /v1/sandboxes list call — replay is resolved purely via the retry.
    expect(calls.some((c) => c.method === 'GET' && c.path === '/v1/sandboxes')).toBe(false);
  });

  test('a definitive non-name_taken error (e.g. 503) is NOT retried by the dedup layer — propagates untouched', async () => {
    createSequence = [
      { error: new Error('platinum POST /v1/sandboxes?wait_for_state=running -> 503 {"error":"unavailable"}') },
    ];
    const p = new PlatinumProvider();

    await expect(p.create({ ...baseOpts, createAttempt: 1 })).rejects.toThrow(/503/);
    expect(createCalls()).toHaveLength(1);
  });
});

describe('S1 one logical create yields at most one box', () => {
  test('a clean success POSTs exactly once', async () => {
    const p = new PlatinumProvider();
    await p.create({ ...baseOpts, createAttempt: 1 });
    expect(createCalls()).toHaveLength(1);
  });
});

describe('S1 monotonic attempt counter (session-sandbox.ts restore-on-resume)', () => {
  test('restorePlatinumCreateAttempt returns 0 for a fresh row (no prior attempt persisted)', () => {
    expect(restorePlatinumCreateAttempt(null)).toBe(0);
    expect(restorePlatinumCreateAttempt(undefined)).toBe(0);
    expect(restorePlatinumCreateAttempt({})).toBe(0);
  });

  test('restorePlatinumCreateAttempt restores a persisted value (simulated process restart) instead of resetting', () => {
    // A previous process crashed mid-attempt-2 after persisting the counter
    // but before finishing. A resumed process must pick up attempt 2 (reuse
    // it — so an Idempotency-Key replay can still adopt a box that actually
    // committed), never reset to 0/1 (which would mint a NEW, unrelated
    // create identity and could orphan a live box).
    expect(restorePlatinumCreateAttempt({ platinumCreateAttempt: 2 })).toBe(2);
  });

  test('malformed/negative persisted values fall back to 0, never a crash or a negative attempt', () => {
    expect(restorePlatinumCreateAttempt({ platinumCreateAttempt: -1 })).toBe(0);
    expect(restorePlatinumCreateAttempt({ platinumCreateAttempt: 'nope' })).toBe(0);
    expect(restorePlatinumCreateAttempt({ platinumCreateAttempt: Number.NaN })).toBe(0);
  });

  test('end-to-end: a resumed attempt (restored, not reset) reuses the ORIGINAL name+key, not a fresh one', async () => {
    const restored = restorePlatinumCreateAttempt({ platinumCreateAttempt: 2 });
    expect(restored).toBe(2); // NOT reset to 0/1

    const p = new PlatinumProvider();
    await p.create({ ...baseOpts, createAttempt: restored });
    const create = createCalls()[0];
    expect(create.body?.name).toBe(`kortix-${SANDBOX_ID}-a2`);
  });
});

describe('S1 kill switch', () => {
  test('KORTIX_PLATINUM_CREATE_DEDUP=0 sends the legacy body — no name, no header', async () => {
    process.env.KORTIX_PLATINUM_CREATE_DEDUP = '0';
    const p = new PlatinumProvider();
    await p.create({ ...baseOpts, createAttempt: 1 });

    const create = createCalls()[0];
    expect(create.body?.name).toBeUndefined();
    expect(create.body?.metadata).toBeUndefined();
    expect(create.headers['Idempotency-Key']).toBeUndefined();
  });

  test('omitting sandboxId also falls back to the legacy body (no crash, no dedup)', async () => {
    const p = new PlatinumProvider();
    const { sandboxId: _drop, ...legacyOpts } = baseOpts;
    await p.create({ ...legacyOpts, createAttempt: 1 });

    const create = createCalls()[0];
    expect(create.body?.name).toBeUndefined();
    expect(create.headers['Idempotency-Key']).toBeUndefined();
  });
});
