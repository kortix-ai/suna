// PROD INCIDENT (2026-09-27): the same 2 sessions 409'd `name_taken` every
// ~15 minutes forever with no forward progress. Root cause: platinum.ts's
// name_taken handling retries ONCE under the SAME Idempotency-Key, assuming
// the CP always replays our own already-committed box (see the module doc in
// platinum.ts). That assumption breaks when the CP's idempotency record
// expired, or the per-project template changed between calls (the key is
// derived from (sandboxId, template, attempt) — see buildIdempotencyKey) —
// the retry then hits a genuine, un-replayed conflict and threw. Nothing
// ever advanced `platinumCreateAttempt` on that failure path, so every later
// `/start` retry (see runtime-wake-fence.ts's RUNTIME_START_RETRY_BACKOFF_MS
// cooldown ladder, which settles at a 10-minute ceiling) reissued the
// IDENTICAL name and collided with the SAME still-existing box forever.
//
// A by-name lookup (this file's earlier revision) is NOT viable here: a real
// Platinum org can carry tens of thousands of sandboxes, most `archived` and
// still holding their name under Platinum's `deleted_at IS NULL` uniqueness
// predicate, arbitrarily far past any bounded pagination cap a create-path
// call could afford — and removing/starting a box this call cannot prove is
// unreferenced elsewhere is the orphan reaper's job, never create()'s.
//
// Fix: when name_taken PERSISTS after the replay retry, advance to the NEXT
// attempt — a fresh deterministic name + Idempotency-Key, exactly the
// transition heal/provider-failover/id-boot-fallback already use in
// session-sandbox.ts — and create once more. Bounded to ONE advance per
// call: an advanced create that also 409s throws instead of advancing again.
// The old box under the original name is NEVER touched. The advanced attempt
// is returned in `ProvisionResult.metadata.platinumCreateAttempt`, which the
// caller (session-sandbox.ts) persists verbatim into session_sandboxes.metadata
// — so the NEXT top-level provisioning call's restorePlatinumCreateAttempt
// reads the ADVANCED attempt and never re-mints the stuck name.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
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
let createSequence: Array<{ result?: Record<string, unknown>; error?: Error }> = [];
let createCallCount = 0;

function normalizeHeaders(h: RequestInit['headers']): Record<string, string> {
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries(h.entries());
  if (Array.isArray(h)) return Object.fromEntries(h as [string, string][]);
  return { ...(h as Record<string, string>) };
}

function nameTakenError(name: string): Error {
  return platinumHttpError(
    `platinum POST /v1/sandboxes?wait_for_state=running&wait_timeout_ms=60000 -> 409 ` +
    `{"error":"name '${name}' is already in use by another active sandbox in this org","code":"name_taken","name":"${name}"}`,
  );
}

mock.module('../../shared/platinum', () => ({
  isPlatinumConfigured: () => true,
  platinumJsonResponse: async () => {
    throw new Error('unexpected Platinum materialization request');
  },
  platinumJson: async (path: string, init: RequestInit = {}) => {
    const method = String(init.method ?? 'GET');
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ path, method, headers: normalizeHeaders(init.headers), body });
    if (path.startsWith('/v1/secrets?')) return { items: [], cursor: null };
    if (path === '/v1/secrets' && method === 'POST') return { id: 'sec_1', ...body };
    if (path.startsWith('/v1/sandboxes?wait_for_state=')) {
      const idx = Math.min(createCallCount, createSequence.length - 1);
      createCallCount += 1;
      const scripted = createSequence[idx];
      if (!scripted || scripted.error) throw (scripted?.error ?? new Error('no scripted create response'));
      return scripted.result;
    }
    if (path.includes('/expose')) return { url: 'https://sbx.test/agent', port: 8000, public: true };
    return {};
  },
}));
mock.module('../service-key', () => ({ serviceKeyForExternalId: () => 'svc_key' }));
mock.module('../sandbox-frontend-url', () => ({ sandboxFrontendBaseUrl: () => 'https://app.example.com' }));

const { PlatinumProvider } = await import('./platinum');

const SANDBOX_ID = '11111111-2222-4333-8444-555555555555';
const NAME_A1 = `kortix-${SANDBOX_ID}-a1`;
const NAME_A2 = `kortix-${SANDBOX_ID}-a2`;

const baseOpts = {
  accountId: 'acc_1',
  userId: 'usr_1',
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
  createSequence = [];
  delete process.env.KORTIX_PLATINUM_CREATE_DEDUP;
});

describe('persistent name_taken (survives the replay retry)', () => {
  test('advances to attempt a2 — a fresh name + a fresh Idempotency-Key — and succeeds, never touching the a1 box', async () => {
    createSequence = [
      { error: nameTakenError(NAME_A1) }, // original create
      { error: nameTakenError(NAME_A1) }, // replay retry, same key — still 409
      { result: { id: 'sbx_a2', state: 'running' } }, // advanced create (a2)
    ];

    const p = new PlatinumProvider();
    const res = await p.create({ ...baseOpts, createAttempt: 1 });

    expect(res.externalId).toBe('sbx_a2');
    const posts = createCalls();
    expect(posts).toHaveLength(3);
    expect(posts[0]!.body?.name).toBe(NAME_A1);
    expect(posts[1]!.body?.name).toBe(NAME_A1);
    expect(posts[1]!.headers['Idempotency-Key']).toBe(posts[0]!.headers['Idempotency-Key']);
    expect(posts[2]!.body?.name).toBe(NAME_A2);
    expect(posts[2]!.headers['Idempotency-Key']).not.toBe(posts[0]!.headers['Idempotency-Key']);
    // Never a DELETE, GET, or list call against the a1 box — it is untouched.
    expect(calls.some((c) => c.method === 'DELETE' || c.method === 'GET')).toBe(false);
    expect(calls.some((c) => c.path.startsWith('/v1/sandboxes?paginated=true'))).toBe(false);
  });

  test('persists the advanced attempt in the returned metadata for the caller to durably record', async () => {
    createSequence = [
      { error: nameTakenError(NAME_A1) },
      { error: nameTakenError(NAME_A1) },
      { result: { id: 'sbx_a2', state: 'running' } },
    ];

    const p = new PlatinumProvider();
    const res = await p.create({ ...baseOpts, createAttempt: 1 });

    expect(res.metadata?.platinumCreateAttempt).toBe(2);
  });

  test('an advanced (a2) create that ALSO 409s name_taken throws — never advances again', async () => {
    createSequence = [
      { error: nameTakenError(NAME_A1) },
      { error: nameTakenError(NAME_A1) },
      { error: nameTakenError(NAME_A2) },
    ];

    const p = new PlatinumProvider();
    await expect(p.create({ ...baseOpts, createAttempt: 1 })).rejects.toThrow(/attempt 2|advancing again/i);
    expect(createCalls()).toHaveLength(3); // no 4th (a3) attempt
  });
});

describe('a single name_taken that the replay resolves', () => {
  test('does NOT advance the attempt — metadata still reports attempt 1, exactly 2 create POSTs', async () => {
    createSequence = [
      { error: nameTakenError(NAME_A1) },
      { result: { id: 'sbx_committed', state: 'running', replayed: true } },
    ];

    const p = new PlatinumProvider();
    const res = await p.create({ ...baseOpts, createAttempt: 1 });

    expect(res.externalId).toBe('sbx_committed');
    expect(createCalls()).toHaveLength(2);
    expect(res.metadata?.platinumCreateAttempt).toBe(1);
  });
});
