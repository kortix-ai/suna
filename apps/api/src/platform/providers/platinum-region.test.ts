// `us_region`: a session created with a location asks Platinum for that region.
//
// Platinum serves every region behind the one PLATINUM_API_URL: a create that
// names `region` is forwarded to that region's control plane and every later
// call by id is routed there. These tests pin what Kortix sends and how it
// reads the answer. The harness below is platinum-create-dedup.test.ts's.
// ORIGINAL HARNESS HEADER (platinum-create-dedup.test.ts):
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
const { restorePlatinumCreateAttempt } = await import('../services/session-sandbox');

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


import { createHash } from 'node:crypto';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('us_region: region on the Platinum create', () => {
  test('no location ⇒ no region field, and the Idempotency-Key is byte-identical to the pre-region formula', async () => {
    const p = new PlatinumProvider();
    await p.create({ ...baseOpts, createAttempt: 1 });

    const create = createCalls()[0];
    expect(create.body && 'region' in create.body).toBe(false);
    expect(create.headers['Idempotency-Key']).toBe(sha(`${SANDBOX_ID}|tpl_default|a1`));
  });

  test("location 'us-east' ⇒ body.region, and a key of its own", async () => {
    const p = new PlatinumProvider();
    await p.create({ ...baseOpts, createAttempt: 1, location: 'us-east' });

    const create = createCalls()[0];
    expect(create.body?.region).toBe('us-east');
    expect(create.headers['Idempotency-Key']).toBe(sha(`${SANDBOX_ID}|tpl_default|a1|rus-east`));
    expect(create.headers['Idempotency-Key']).not.toBe(sha(`${SANDBOX_ID}|tpl_default|a1`));
  });

  test('where Platinum placed the box is read from its answer into the session metadata', async () => {
    createSequence = [{
      result: { id: 'sbx_us', state: 'running', region: 'us-east', api_url: 'https://us-east.api.platinum.dev' },
    }];
    const p = new PlatinumProvider();
    const result = await p.create({ ...baseOpts, createAttempt: 1, location: 'us-east' });

    expect(result.metadata?.platinumRegion).toBe('us-east');
    expect(result.metadata?.platinumApiUrl).toBe('https://us-east.api.platinum.dev');
  });

  test('a home-region answer adds nothing that was not there before', async () => {
    const p = new PlatinumProvider();
    const result = await p.create({ ...baseOpts, createAttempt: 1 });

    expect(result.metadata && 'platinumRegion' in result.metadata).toBe(false);
    expect(result.metadata && 'platinumApiUrl' in result.metadata).toBe(false);
  });
});

describe('us_region: a template not yet copied to the region', () => {
  const notResident = (state: string) =>
    new Error(
      'platinum POST /v1/sandboxes?wait_for_state=running&wait_timeout_ms=60000 -> 409 ' +
      JSON.stringify({
        error: "template tpl_default is being copied to region 'us-east' — retry shortly",
        code: 'template_not_resident', template: 'tpl_default', region: 'us-east', state,
      }),
    );

  for (const state of ['replicating', 'absent', 'failed']) {
    test(`409 template_not_resident (${state}) surfaces as the patient "image still building" condition`, async () => {
      createSequence = [{ error: notResident(state) }];
      const p = new PlatinumProvider();
      const err = await p.create({ ...baseOpts, createAttempt: 1, location: 'us-east' }).catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      // sandbox-init-state.ts isSnapshotStillBuilding: /snapshot .+ is building/i
      expect(/snapshot .+ is building/i.test((err as Error).message)).toBe(true);
      expect((err as Error).message).toContain('us-east');
      expect((err as Error).message).toContain(`state=${state}`);
      // One POST: the retry window belongs to the provisioning loop, not here.
      expect(createCalls()).toHaveLength(1);
    });
  }

  test('any other refusal (region not granted) is rethrown untouched', async () => {
    const refused = new Error(
      'platinum POST /v1/sandboxes?wait_for_state=running&wait_timeout_ms=60000 -> 403 ' +
      JSON.stringify({ error: "region 'us-east' is not enabled for this organization", code: 'region_not_enabled' }),
    );
    createSequence = [{ error: refused }];
    const p = new PlatinumProvider();
    const err = await p.create({ ...baseOpts, createAttempt: 1, location: 'us-east' }).catch((e) => e);

    expect(err).toBe(refused);
  });
});
