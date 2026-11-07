/**
 * The playground's per-model catch never echoes a database error's message
 * to the client (KRTX-4400). `recordGatewayUsage`/`persistGatewayTrace` can
 * reject with a `DrizzleQueryError`/`PostgresError` whose message is the
 * whole generated SQL statement plus its bound parameters. That catch sits
 * inside `Promise.all`, outside the route's own try/catch, so it never
 * reaches the global handler that already turns an uncaught database error
 * into a generic 500 (`shared/http-errors.ts`) — a crafted `model` value that
 * made the write fail would otherwise return the raw statement straight to
 * an authenticated caller: a SQL error oracle.
 *
 * Two levels: the unit tests pin the extracted helper's classification
 * directly; the integration test drives the REAL route handler (through the
 * shared `projectsApp`, with its collaborators stubbed) to prove the catch
 * block actually calls that helper, not just that the helper itself is safe
 * in isolation — the route and access layers follow the pattern of
 * `project-cli-token-list.test.ts` (`mock.module` is process-global in
 * bun:test, so this runs in its own file).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

describe('playgroundModelError (unit)', () => {
  test('a database error never echoes its message', async () => {
    const { playgroundModelError } = await import('./gateway-playground');
    class PostgresError extends Error {
      override name = 'PostgresError';
    }
    const err = new PostgresError(
      'insert into usage_events (account_id, project_id, model, ...) values ($1, $2, $3, ...) - duplicate key value violates unique constraint "usage_events_request_id_key"',
    );
    expect(playgroundModelError(err, 'claude-sonnet-4.6')).toBe('Request failed');
  });

  test('a DrizzleQueryError-shaped error (name only, no driver import) never echoes its message', async () => {
    const { playgroundModelError } = await import('./gateway-playground');
    // Mirrors drizzle-orm's DrizzleQueryError shape without importing the
    // class: isDatabaseError also matches on `name === 'PostgresError'` in
    // the cause chain, which is what a raw postgres.js rejection carries.
    const cause = new Error('syntax error at or near "\'"');
    (cause as Error & { name: string }).name = 'PostgresError';
    const err = new Error('Failed query: insert into usage_events ...', { cause });
    expect(playgroundModelError(err, "bad'model")).toBe('Request failed');
  });

  test('a typed, non-database error still echoes its own message', async () => {
    const { playgroundModelError } = await import('./gateway-playground');
    const err = new Error('No upstream configured for this model');
    expect(playgroundModelError(err, 'unknown-model')).toBe('No upstream configured for this model');
  });

  test('a non-Error throw falls back to the generic message', async () => {
    const { playgroundModelError } = await import('./gateway-playground');
    expect(playgroundModelError('boom', 'claude-sonnet-4.6')).toBe('Request failed');
  });
});

// ---------------------------------------------------------------------------
// Integration: the real route, with its collaborators stubbed.
// ---------------------------------------------------------------------------

const PROJECT_ID = '00000000-0000-4000-a000-0000000290a0';
const ACCOUNT_ID = '00000000-0000-4000-a000-0000000290a1';
const USER_ID = '00000000-0000-4000-a000-0000000290a2';

class PostgresError extends Error {
  override name = 'PostgresError';
}

/** What `recordGatewayUsage` rejects with for this test — set per test. */
let recordUsageRejection: unknown = null;

mock.module('../../shared/db', () => ({
  hasDatabase: () => true,
  // Import-time safety only: the handler under test touches neither `db` nor
  // a real repository query (every collaborator below is stubbed); any use
  // here is a bug.
  db: new Proxy({}, {
    get: () => () => new Proxy({}, { get: () => () => ({ returning: async () => [] }) }),
  }),
}));

mock.module('../lib/access', () => ({
  loadProjectForUser: async () => ({
    userId: USER_ID,
    row: { projectId: PROJECT_ID, accountId: ACCOUNT_ID },
    projectRole: 'owner',
    effectiveRole: 'owner',
  }),
  assertProjectCapability: async () => {},
}));

mock.module('../../llm-gateway/resolution/resolve-candidates', () => ({
  resolveCandidates: async () => [
    {
      provider: 'anthropic',
      resolvedModel: 'claude-sonnet-4.6',
      publicProvider: false,
      billingMode: 'credits',
      markup: 1,
      pricing: undefined,
    },
  ],
}));

mock.module('../../llm-gateway/models/catalog-models', () => ({
  catalogModelForWireModel: () => undefined,
}));

mock.module('@kortix/llm-gateway', () => ({
  calculateCost: () => ({ upstreamCost: 0, finalCost: 0 }),
  callUpstream: async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      model: 'claude-sonnet-4.6',
      usage: { prompt_tokens: 5, completion_tokens: 5 },
      choices: [{ message: { content: 'hi' } }],
    }),
  }),
  publicPayload: (data: unknown) => data,
  publicUpstreamError: () => null,
  shownModel: () => 'claude-sonnet-4.6',
  shownProvider: () => 'anthropic',
}));

mock.module('../../llm-gateway/hooks', () => ({
  assertGatewayBudget: async () => {},
  GatewayBudgetExceededError: class GatewayBudgetExceededError extends Error {},
  persistGatewayTrace: async () => {},
  recordGatewayUsage: async () => {
    if (recordUsageRejection) throw recordUsageRejection;
  },
}));

// Registers gateway-playground.ts's route onto the shared `projectsApp`
// singleton. projects.ts (which attaches the `supabaseAuth` middleware) is
// deliberately NOT imported, so this request needs no Authorization header
// — same technique as project-cli-token-list.test.ts.
const { projectsApp } = await import('../lib/app');
(await import('./gateway-playground')).registerGatewayPlaygroundRoutes();

function runPlayground(models: string[]) {
  return projectsApp.request(`/${PROJECT_ID}/gateway/playground`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'hello', models }),
  });
}

interface PlaygroundResult {
  model: string;
  ok: boolean;
  error?: string;
}

beforeEach(() => {
  recordUsageRejection = null;
});

describe('POST /:projectId/gateway/playground — a database error never reaches the client', () => {
  test('a successful model run reports ok with no error', async () => {
    const res = await runPlayground(['claude-sonnet-4.6']);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: PlaygroundResult[] };
    expect(body.results[0]?.ok).toBe(true);
    expect(body.results[0]?.error).toBeUndefined();
  });

  test('recordGatewayUsage rejecting with a PostgresError answers "Request failed", not the SQL statement', async () => {
    recordUsageRejection = new PostgresError(
      'insert into usage_events (account_id, project_id, model, ...) values ($1, $2, $3, ...) - duplicate key value violates unique constraint "usage_events_request_id_key"',
    );
    const res = await runPlayground(['claude-sonnet-4.6']);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: PlaygroundResult[] };
    expect(body.results[0]?.ok).toBe(false);
    expect(body.results[0]?.error).toBe('Request failed');
    expect(body.results[0]?.error).not.toContain('insert into');
    expect(body.results[0]?.error).not.toContain('usage_events');
  });

  test('a wallet settlement failure that wraps a database error answers "Request failed"', async () => {
    // billing/wallet settle() rethrows a failed debit as a plain Error whose
    // message carries the driver text and whose cause is the driver error.
    recordUsageRejection = new Error('Credit settlement failed for acct: Failed query: select kortix_wallet.debit_credits(...)', {
      cause: new PostgresError('invalid input syntax'),
    });
    const res = await runPlayground(['claude-sonnet-4.6']);
    const body = (await res.json()) as { results: PlaygroundResult[] };
    expect(body.results[0]?.error).toBe('Request failed');
  });

  test('recordGatewayUsage rejecting with a typed, non-database error still echoes its own message', async () => {
    recordUsageRejection = new Error('usage ledger is temporarily read-only');
    const res = await runPlayground(['claude-sonnet-4.6']);
    const body = (await res.json()) as { results: PlaygroundResult[] };
    expect(body.results[0]?.ok).toBe(false);
    expect(body.results[0]?.error).toBe('usage ledger is temporarily read-only');
  });
});
