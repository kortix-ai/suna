/**
 * Drives the real POST /:projectId/sessions/:sessionId/log/journal handler
 * under the REAL request-deadline middleware to prove KRTX-2737: when a
 * journal batch outlives the deadline (a session-log convoy holds the
 * advisory lock while a large batch replays), the guard answers its own 503
 * and the handler keeps running as the race loser. When the ingest then
 * settles with the contended 429, the handler must not touch the finalized
 * context — prod 2026-10-17 15:23:17, the `Retry-After: 2` branch called
 * `c.header('Retry-After', '2')` on the served context and Bun rejected the
 * re-wrap of the consumed body stream with
 * `TypeError: Body object should not be disturbed or locked` (Better Stack
 * app 2346961, pattern aacd2339…).
 *
 * The KRTX-2600 fix for the audit-ingest route's identical contended branch
 * (project-audit-ingest-deadline.test.ts) is the precedent: one c.json call
 * with the header inline — never `c.header(...)` first.
 *
 * The deadline is forced to 1 ms and the mocked SELECT unblocks only once the
 * context IS finalized, so the contended branch runs strictly after the
 * deadline 503 was served — deterministic, no clock race.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Context } from 'hono';

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

const ACCOUNT_ID = 'd7600000-0000-4000-a000-000000000001';
const PROJECT_ID = 'd7700000-0000-4000-a000-000000000001';
const SESSION_ID = 'd7800000-0000-4000-a000-000000000001';

/** The captured request context; the deadline path finalizes it mid-handler. */
let capturedCtx: Context | null = null;

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
    // sessionExists: the ingest's first await; it holds the handler past the
    // deadline and then answers true so the batch reaches the advisory lock.
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            await waitUntilFinalized();
            return [{ sessionId: SESSION_ID }];
          },
        }),
      }),
    }),
    // The advisory lock is lost — the convoy shape — so applyBatch returns
    // BUSY: the 429 branch whose `Retry-After: 2` is under test.
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ execute: async () => [{ locked: false }] }),
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

// The deadline guard is the outermost middleware, exactly as the production
// app mounts it: its 1 ms race finalizes the context while the handler below
// it is still awaiting the ingest.
projectsApp.use('*', (c, next) => requestDeadline(c, next));
projectsApp.use('*', (c, next) => {
  capturedCtx = c;
  return next();
});
projectsApp.use('*', async (c, next) => {
  c.set('authType', 'apiKey');
  c.set('apiKeyType', 'sandbox');
  c.set('accountId', ACCOUNT_ID);
  c.set('sandboxId', SESSION_ID);
  // sandboxScope(c) binds the session-sandbox credential to the path session.
  c.set('sessionId', SESSION_ID);
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

const { registerSessionLogRoutes } = await import('./session-log');
registerSessionLogRoutes();

const JOURNAL_BODY = { generation: 0, puts: [], tombstones: [], threads: [] };

beforeEach(() => {
  capturedCtx = null;
  capturedErrors.length = 0;
  deadlineGuardCount = 0;
});

afterAll(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('POST …/log/journal under the request-deadline guard', () => {
  test('a contended ingest that settles after the deadline answered does not touch the finalized context', async () => {
    const res = await projectsApp.request(`/${PROJECT_ID}/sessions/${SESSION_ID}/log/journal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(JOURNAL_BODY),
    });

    // The client-visible contract is unchanged: the deadline guard answered.
    // res.text() FIRST — the mocked SELECT unblocks on a 1 ms sleep after
    // finalization, so the abandoned handler cannot re-wrap the body stream
    // before the test consumes it (that re-wrap is the very bug under test;
    // in production Bun.serve's socket write is the consumer).
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('10');
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ code: 'request_deadline' });
    expect(deadlineGuardCount).toBe(1);

    // The abandoned handler keeps running past the response (the race loser)
    // and settles on the contended 429. Give it a beat, then require it
    // produced NO second error: the production onError captureException()s
    // that TypeError into Better Stack (pattern aacd2339…). The batch's
    // outcome is discarded by compose and the client keeps the deadline 503 —
    // nothing here may surface as a captured error.
    await Bun.sleep(50);
    expect(capturedErrors).toEqual([]);
  });
});
