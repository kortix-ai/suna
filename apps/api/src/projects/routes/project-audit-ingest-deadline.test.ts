/**
 * Drives the real POST /:projectId/sessions/:sessionId/audit/events handler
 * under the REAL request-deadline middleware to prove KRTX-2600: when a
 * contended ingest settles after the deadline guard has already answered this
 * request (hono's deadline is a Promise.race — the handler keeps running as
 * its loser), the handler must not touch the finalized context.
 * `Context#header` on a finalized context re-wraps the response body
 * (`new Response(this.#res.body, this.#res)`); the runtime already consumed
 * that body to serve the deadline 503, and Bun throws
 * `TypeError: Body object should not be disturbed or locked` — Better Stack
 * app 2346961, pattern a9fcb90d…, prod 2026-10-16, one occurrence per
 * contended ingest that settled past its deadline.
 *
 * The deadline is forced to 1 ms and the mocked SELECT unblocks only once the
 * context IS finalized, so the contended branch runs strictly after the
 * deadline 503 was served — deterministic, no clock race.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { auditEvents, serviceAccounts, sessionSandboxes } from '@kortix/db';

const ORIGINAL_ENV = {
  ALLOWED_SANDBOX_PROVIDERS: process.env.ALLOWED_SANDBOX_PROVIDERS,
  FRONTEND_URL: process.env.FRONTEND_URL,
  INTERNAL_KORTIX_ENV: process.env.INTERNAL_KORTIX_ENV,
  SUPABASE_URL: process.env.SUPABASE_URL,
  REQUEST_DEADLINE_MS: process.env.REQUEST_DEADLINE_MS,
};
process.env.ALLOWED_SANDBOX_PROVIDERS = 'daytona';
process.env.FRONTEND_URL = 'https://app.test.kortix.local';
process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.SUPABASE_URL = 'https://supabase.test.kortix.local';
// Read at module load: must be set before request-deadline is (transitively)
// imported, so this test's guard bounds at 1 ms instead of the 25 s default.
process.env.REQUEST_DEADLINE_MS = '1';

const ACCOUNT_ID = 'd7100000-0000-4000-a000-000000000001';
const PROJECT_ID = 'd7200000-0000-4000-a000-000000000001';
const SESSION_ID = 'd7300000-0000-4000-a000-000000000001';
const AGENT_ID = 'd7400000-0000-4000-a000-000000000001';
const HUMAN_ID = 'd7500000-0000-4000-a000-000000000001';

/** When set, every INSERT from this 0-based index on rejects with this error. */
let failStatementFrom: { index: number; error: unknown } | null = null;
/** One entry per INSERT statement the handler issued, holding that statement's rows. */
let insertStatements: Array<Array<Record<string, unknown>>> = [];

const sandboxScope = {
  sessionId: SESSION_ID,
  opencodeSessionId: 'ses_server_owned',
  agentName: 'trusted-agent',
  createdBy: HUMAN_ID,
};

const identityRows = [{ serviceAccountId: AGENT_ID, agentName: 'trusted-agent' }];

function rowsFor(table: unknown): unknown[] {
  if (table === sessionSandboxes) return [sandboxScope];
  if (table === serviceAccounts) return identityRows;
  return [];
}

/** The captured request context; the deadline path finalizes it mid-handler. */
type FinalizedContext = { finalized: boolean };
let capturedCtx: FinalizedContext | null = null;

/**
 * Resolves only once the captured context is finalized — the deadline guard
 * answered and onError assigned its 503. This is what pins the handler's
 * contended branch strictly after the client already received its response.
 */
async function waitUntilFinalized(): Promise<void> {
  // Anti-hang cap: past it the status/code assertions fail visibly.
  const cap = Date.now() + 1_000;
  while (!(capturedCtx && capturedCtx.finalized) && Date.now() < cap) {
    await Bun.sleep(1);
  }
}

mock.module('../../shared/db', () => ({
  hasDatabase: () => true,
  db: {
    select: () => ({
      from: (table: unknown) => {
        const query = {
          where: () => {
            const rows = rowsFor(table);
            return Object.assign(waitUntilFinalized().then(() => rows), {
              limit: async () => {
                await waitUntilFinalized();
                return rows.slice(0, 1);
              },
            });
          },
        };
        return {
          ...query,
          innerJoin: () => query,
        };
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Array<Record<string, unknown>>) => {
        if (table !== auditEvents) throw new Error('unexpected insert table');
        const index = insertStatements.length;
        insertStatements.push([...values]);
        return {
          onConflictDoNothing: () => ({
            returning: async () => {
              if (failStatementFrom && index >= failStatementFrom.index) {
                throw failStatementFrom.error;
              }
              return values.map((value) => ({ eventId: value.eventId }));
            },
          }),
        };
      },
    }),
  },
}));

const { projectsApp } = await import('../lib/app');
type RequestDeadlineModule = typeof import('../../middleware/request-deadline');
const requestDeadline: RequestDeadlineModule['requestDeadline'] = (
  await import('../../middleware/request-deadline')
).requestDeadline;
const isRequestDeadlineHTTPException: RequestDeadlineModule['isRequestDeadlineHTTPException'] = (
  await import('../../middleware/request-deadline')
).isRequestDeadlineHTTPException;
const { __resetAuditRateGuardForTest } = await import('../../shared/opencode-audit-rate-guard');

// The deadline guard is the outermost middleware, exactly as the production
// app mounts it: its 1 ms race finalizes the context while the handler below
// it is still awaiting the write.
projectsApp.use('*', (c, next) => requestDeadline(c, next));
projectsApp.use('*', (c, next) => {
  capturedCtx = c as unknown as FinalizedContext;
  return next();
});
projectsApp.use('*', async (c, next) => {
  c.set('authType', 'apiKey');
  c.set('apiKeyType', 'sandbox');
  c.set('accountId', ACCOUNT_ID);
  c.set('sandboxId', SESSION_ID);
  await next();
});

/**
 * Mirrors the production global onError just enough to observe the failure:
 * the deadline 503 is answered on the (then finalized) context, and any OTHER
 * error is recorded the way the production handler captureException()s it —
 * Better Stack saw the abandoned handler's TypeError exactly through that
 * second onError invocation.
 */
const capturedErrors: Array<{ name: string; message: string }> = [];
let deadlineGuardCount = 0;
projectsApp.onError((err, c) => {
  if (isRequestDeadlineHTTPException(err)) {
    deadlineGuardCount += 1;
    c.header('Retry-After', '10');
    return c.json({ error: err.message, code: 'request_deadline' }, 503);
  }
  const error = err as Error;
  capturedErrors.push({ name: error.name, message: error.message });
  return c.json({ error: true, message: 'internal' }, 500);
});

const { registerProjectAuditRoutes } = await import('./project-audit');
registerProjectAuditRoutes();

function plainEvent(n: number) {
  return {
    event_id: n.toString(16).padStart(64, '0'),
    source_revision: `rev-${n}`,
    type: 'file.edited',
    occurred_at: '2026-08-08T12:00:00.000Z',
    outcome: 'success',
    phase: 'completed',
    input_sha256: 'c'.repeat(64),
  };
}

beforeEach(() => {
  failStatementFrom = null;
  capturedCtx = null;
  insertStatements = [];
  capturedErrors.length = 0;
  deadlineGuardCount = 0;
  __resetAuditRateGuardForTest();
});

afterAll(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('POST …/audit/events under the request-deadline guard', () => {
  test('a contended ingest that settles after the deadline answered does not touch the finalized context', async () => {
    // postgres.js surfaces statement_timeout while queued on a row lock as
    // SQLSTATE 57014 — the contention the route answers with its controlled
    // 503 + Retry-After: 5. One event keeps the batch at the 25-row floor, so
    // the first statement IS the contended one (no fallback halving).
    failStatementFrom = {
      index: 0,
      error: Object.assign(new Error('canceling statement due to statement timeout'), {
        code: '57014',
      }),
    };

    const res = await projectsApp.request(`/${PROJECT_ID}/sessions/${SESSION_ID}/audit/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [plainEvent(0)] }),
    });

    // The client-visible contract is unchanged: the deadline guard answered.
    // res.text() FIRST — the mocked SELECT unblocks on a 1 ms sleep after
    // finalization, so the abandoned handler cannot re-wrap the body stream
    // before the test consumes it (that re-wrap is the very bug under test).
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('10');
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ code: 'request_deadline' });
    expect(deadlineGuardCount).toBe(1);

    // The abandoned handler keeps running past the response (the race loser).
    // Give it a beat to settle, then require it produced NO second error:
    // the production onError captureException()s that TypeError into Better
    // Stack (pattern a9fcb90d…). The contended ingest rows still land via
    // onConflictDoNothing and the relay absorbs the outcome — nothing here
    // may surface as a captured error.
    await Bun.sleep(50);
    expect(capturedErrors).toEqual([]);
  });
});
