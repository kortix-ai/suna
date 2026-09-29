/**
 * Drives the real POST /:projectId/sessions/:sessionId/audit/events handler.
 * The sandbox payload is hostile. Canonical attribution must come only from
 * the project_sessions and service_accounts rows selected by the handler.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { auditEvents, serviceAccounts, sessionSandboxes } from '@kortix/db';
import { MAX_BATCH_SIZE } from '../../shared/opencode-audit-ingestion';
import { runWithContext } from '../../lib/request-context';
import { attachInboundAuditScope } from '../../shared/audit-scope';
import {
  SESSION_EVENT_RATE_LIMITED_ACTION,
  __resetAuditRateGuardForTest,
} from '../../shared/opencode-audit-rate-guard';

const ORIGINAL_ENV = {
  ALLOWED_SANDBOX_PROVIDERS: process.env.ALLOWED_SANDBOX_PROVIDERS,
  FRONTEND_URL: process.env.FRONTEND_URL,
  INTERNAL_KORTIX_ENV: process.env.INTERNAL_KORTIX_ENV,
  SUPABASE_URL: process.env.SUPABASE_URL,
};
process.env.ALLOWED_SANDBOX_PROVIDERS = 'daytona';
process.env.FRONTEND_URL = 'https://app.test.kortix.local';
process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.SUPABASE_URL = 'https://supabase.test.kortix.local';

const ACCOUNT_ID = 'd7100000-0000-4000-a000-000000000001';
const PROJECT_ID = 'd7200000-0000-4000-a000-000000000001';
const SESSION_ID = 'd7300000-0000-4000-a000-000000000001';
const AGENT_ID = 'd7400000-0000-4000-a000-000000000001';
const HUMAN_ID = 'd7500000-0000-4000-a000-000000000001';

let insertedValues: Array<Record<string, unknown>> = [];
/** One entry per INSERT statement the handler issued, holding that statement's rows. */
let insertStatements: Array<Array<Record<string, unknown>>> = [];
/** When set, the Nth (0-based) statement rejects with this error. */
let failStatementAt: { index: number; error: unknown } | null = null;
/** Wall-clock milliseconds each mocked INSERT consumes; 0 by default. */
let insertDelayMs = 0;

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

mock.module('../../shared/db', () => ({
  hasDatabase: () => true,
  db: {
    select: () => ({
      from: (table: unknown) => {
        const whereResult = () => {
          const rows = rowsFor(table);
          return Object.assign(Promise.resolve(rows), {
            limit: async () => rows.slice(0, 1),
          });
        };
        const query = { where: whereResult };
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
        insertedValues = values;
        return {
          onConflictDoNothing: () => ({
            returning: async () => {
              if (insertDelayMs > 0) await Bun.sleep(insertDelayMs);
              if (failStatementAt?.index === index) throw failStatementAt.error;
              return values.map((value) => ({ eventId: value.eventId }));
            },
          }),
        };
      },
    }),
  },
}));

const { projectsApp } = await import('../lib/app');
projectsApp.use('*', async (c, next) => {
  c.set('authType', 'apiKey');
  c.set('apiKeyType', 'sandbox');
  c.set('accountId', ACCOUNT_ID);
  c.set('sandboxId', SESSION_ID);
  await next();
});
const { auditIngestChunkSize, boundChunkWrite } = await import('./project-audit');

function hostileEvent() {
  return {
    event_id: 'a'.repeat(64),
    source_revision: 'd7600000-0000-4000-a000-000000000001',
    type: 'tool.execute.after',
    occurred_at: '2026-08-08T12:00:00.000Z',
    opencode_session_id: 'ses_forged',
    agent_id: 'forged-agent',
    agent_name: 'forged-agent',
    initiator_actor_type: 'service_account',
    initiator_actor_id: 'd7700000-0000-4000-a000-000000000001',
    correlation_id: 'forged-correlation',
    causation_id: 'forged-causation',
    delegation_depth: 99,
    outcome: 'success',
    phase: 'completed',
    input_summary: { tool: 'bash', status: 'completed' },
    output_summary: { type: 'object' },
    input_sha256: 'b'.repeat(64),
    output_sha256: 'c'.repeat(64),
  };
}

beforeEach(() => {
  insertedValues = [];
  insertStatements = [];
  failStatementAt = null;
  insertDelayMs = 0;
});

afterAll(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('POST /:projectId/sessions/:sessionId/audit/events', () => {
  test('cannot promote forged sandbox provenance into canonical audit columns', async () => {
    const response = await projectsApp.request(
      `/${PROJECT_ID}/sessions/${SESSION_ID}/audit/events`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: [hostileEvent()] }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accepted: 1,
      inserted: 1,
      duplicates: 0,
      suppressed: 0,
    });
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]).toMatchObject({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      opencodeSessionId: 'ses_server_owned',
      actorType: 'agent',
      agentId: AGENT_ID,
      agentName: 'trusted-agent',
      initiatorActorType: 'human',
      initiatorActorId: HUMAN_ID,
      correlationId: SESSION_ID,
      causationId: null,
      delegationDepth: 0,
      metadata: {
        provenance_trust: 'sandbox_reported',
        reported_provenance: {
          opencode_session_id: 'ses_forged',
          agent_id: 'forged-agent',
          agent_name: 'forged-agent',
          initiator_actor_type: 'service_account',
          initiator_actor_id: 'd7700000-0000-4000-a000-000000000001',
          correlation_id: 'forged-correlation',
          causation_id: 'forged-causation',
          delegation_depth: 99,
        },
      },
    });
  });
});

/**
 * The relay's default batch size is this route's own ceiling
 * (`MAX_RELAY_BATCH_SIZE` in
 * apps/kortix-sandbox-agent-server/src/harness/open-code/opencode-audit-relay.ts). Pin both ends
 * of the boundary so raising one without the other cannot ship a 400 into the
 * emission hot path.
 */
describe('relay batch ceiling', () => {
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

  async function post(count: number) {
    const response = await projectsApp.request(
      `/${PROJECT_ID}/sessions/${SESSION_ID}/audit/events`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: Array.from({ length: count }, (_, i) => plainEvent(i)) }),
      },
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  test('accepts a full 200-event relay batch and writes it as one statement', async () => {
    insertStatements.length = 0;
    const accepted = await post(200);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ accepted: 200, inserted: 200 });
    // One bounded statement per accepted batch: every extra statement is one
    // more lock acquisition and round trip a concurrent writer for the same
    // session can interleave at. See `auditIngestChunkSize`.
    expect(insertStatements.map((batch) => batch.length)).toEqual([200]);
  });

  test('the default chunk equals the route batch ceiling so a batch is one statement', () => {
    // Fails while the default still splits a batch (prod 2026-09-29: hot
    // sessions posted full 200-event batches, 8 statements each, and the
    // interleaved lock acquisitions drove audit/events past the request
    // deadline). The route reads the ceiling through `auditIngestChunkSize`.
    delete process.env.KORTIX_AUDIT_INGEST_CHUNK;
    expect(auditIngestChunkSize()).toBe(MAX_BATCH_SIZE);
    expect(MAX_BATCH_SIZE).toBe(200);
  });

  test('rejects one event past the ceiling', async () => {
    const rejected = await post(201);
    expect(rejected.status).toBe(400);
    expect(String(rejected.body.error)).toContain('1 to 200');
  });
});

/**
 * The runaway guard, exercised through the real route rather than the pure
 * function — this is the layer that decides what actually reaches the INSERT.
 */
describe('per-session ingest ceiling', () => {
  const CEILING = 5;

  function deltaEvent(n: number) {
    return {
      event_id: n.toString(16).padStart(64, '0'),
      source_revision: `rev-${n}`,
      type: 'message.part.delta',
      occurred_at: '2026-08-08T12:00:00.000Z',
      outcome: 'success',
      phase: 'completed',
      input_sha256: 'b'.repeat(64),
    };
  }

  async function post(events: unknown[]) {
    const response = await projectsApp.request(
      `/${PROJECT_ID}/sessions/${SESSION_ID}/audit/events`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events }),
      },
    );
    return { status: response.status, body: (await response.json()) as Record<string, number> };
  }

  beforeEach(() => {
    process.env.KORTIX_AUDIT_SESSION_EVENT_CEILING = String(CEILING);
    __resetAuditRateGuardForTest();
  });

  afterAll(() => {
    delete process.env.KORTIX_AUDIT_SESSION_EVENT_CEILING;
    __resetAuditRateGuardForTest();
  });

  test('persists every delta while the session stays under the ceiling', async () => {
    const { status, body } = await post([deltaEvent(1), deltaEvent(2), deltaEvent(3)]);

    expect(status).toBe(200);
    expect(body).toEqual({ accepted: 3, inserted: 3, duplicates: 0, suppressed: 0 });
    expect(insertedValues).toHaveLength(3);
  });

  test('stops persisting deltas over the ceiling and records one notice', async () => {
    const { status, body } = await post(Array.from({ length: 12 }, (_, i) => deltaEvent(i + 1)));

    expect(status).toBe(200);
    expect(body.accepted).toBe(12);
    expect(body.suppressed).toBe(12 - CEILING);

    // 5 deltas + 1 rate-limited notice reach the INSERT; the other 7 never do.
    expect(insertedValues).toHaveLength(CEILING + 1);
    const notices = insertedValues.filter(
      (value) => value.action === SESSION_EVENT_RATE_LIMITED_ACTION,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      actorType: 'system',
      outcome: 'denied',
    });
    expect(
      insertedValues.filter((value) => value.action === 'opencode.message.part.delta'),
    ).toHaveLength(CEILING);
  });

  test('a runaway session never blocks the request or loses lifecycle events', async () => {
    await post(Array.from({ length: 12 }, (_, i) => deltaEvent(i + 1)));

    const lifecycle = {
      ...deltaEvent(99),
      event_id: 'f'.repeat(64),
      type: 'session.idle',
    };
    const { status, body } = await post([lifecycle]);

    expect(status).toBe(200);
    expect(body.suppressed).toBe(0);
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]).toMatchObject({ action: 'opencode.session.idle' });
  });
});

/**
 * The 2026-08-26 convoy: `kortix.audit_prepare_event` locks this
 * session's `audit_session_sequences` row for every row inserted, and
 * PostgreSQL holds that lock until COMMIT. One long statement pinned the
 * session for its whole duration, and a rollback threw away the whole batch's
 * work — which the relay then re-sent in full, every second, for 3 hours.
 *
 * These fixtures pin the operator-override shape
 * (`KORTIX_AUDIT_INGEST_CHUNK=25`) so the multi-statement loop stays covered
 * even though the default writes one statement per accepted batch.
 */
describe('audit ingest contention', () => {
  const CHUNK = 25;

  function event(n: number) {
    return {
      event_id: n.toString(16).padStart(64, '0'),
      source_revision: `contention-${n}`,
      type: 'tool.execute.after',
      occurred_at: '2026-08-26T09:00:00.000Z',
      outcome: 'success',
      phase: 'completed',
      input_sha256: 'b'.repeat(64),
    };
  }

  function request(count: number) {
    return projectsApp.request(`/${PROJECT_ID}/sessions/${SESSION_ID}/audit/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: Array.from({ length: count }, (_, i) => event(i + 1)) }),
    });
  }

  async function post(count: number) {
    const response = await request(count);
    return {
      status: response.status,
      retryAfter: response.headers.get('retry-after'),
      body: (await response.json()) as Record<string, unknown>,
    };
  }

  beforeEach(() => {
    __resetAuditRateGuardForTest();
    // Route down to 25-row statements so the bounded multi-statement loop and
    // the keep-committed-rows property stay exercised at the small-chunk
    // setting an operator can still choose.
    process.env.KORTIX_AUDIT_INGEST_CHUNK = String(CHUNK);
  });

  afterAll(() => {
    delete process.env.KORTIX_AUDIT_INGEST_CHUNK;
    __resetAuditRateGuardForTest();
  });

  test('writes one batch as bounded statements instead of a single long lock', async () => {
    const { status, body } = await post(60);

    expect(status).toBe(200);
    expect(body).toEqual({ accepted: 60, inserted: 60, duplicates: 0, suppressed: 0 });
    // 25 + 25 + 10, never one 60-row statement holding the session lock throughout.
    expect(insertStatements.map((batch) => batch.length)).toEqual([CHUNK, CHUNK, 10]);
  });

  test('lock contention is a retryable 503, never a 500, and keeps committed rows', async () => {
    // postgres.js surfaces statement_timeout while queued on a row lock as
    // SQLSTATE 57014 — the exact code SampleCo returned 445 times in 3h.
    failStatementAt = {
      index: 1,
      error: Object.assign(new Error('canceling statement due to statement timeout'), {
        code: '57014',
      }),
    };

    const { status, retryAfter, body } = await post(60);

    expect(status).toBe(503);
    expect(retryAfter).toBe('5');
    expect(body).toMatchObject({
      accepted: 60,
      inserted: CHUNK,
      duplicates: 0,
      suppressed: 0,
      retry_after_seconds: 5,
    });
    expect(typeof body.error).toBe('string');
    // Stopped at the statement that was rejected. Pushing the third chunk into
    // the same lock queue is what deepened the convoy.
    expect(insertStatements).toHaveLength(2);
  });

  test('a lock_timeout rejection (55P03) is treated the same as 57014', async () => {
    failStatementAt = {
      index: 0,
      error: Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
    };

    const { status, body } = await post(30);

    expect(status).toBe(503);
    expect(body).toMatchObject({ accepted: 30, inserted: 0 });
    expect(insertStatements).toHaveLength(1);
  });

  test('a genuine write failure is not laundered into a retryable 503', async () => {
    // 23505 is a real defect, not backpressure. Reporting it as retryable would
    // make the relay re-send a batch that can never land.
    failStatementAt = {
      index: 0,
      error: Object.assign(new Error('duplicate key value'), { code: '23505' }),
    };

    const response = await request(4);

    expect(response.status).toBe(500);
    expect(response.headers.get('retry-after')).toBeNull();
  });
});

/**
 * The ingest loop against the request's 25s server deadline
 * (`remainingIngestBudgetMs` in project-audit.ts). A multi-chunk batch under a
 * slow database used to run past the deadline mid-loop and die with the
 * error-level `request exceeded the 25s server processing deadline` abort
 * (prod 2026-09-28: the route's dominant error class, hours of 700-1000
 * lines/h against a 141/h baseline). Now the loop stops at a chunk boundary
 * and answers with the same controlled contended 503 the lock path returns.
 */
describe('audit ingest request-deadline budget', () => {
  beforeEach(() => {
    process.env.KORTIX_AUDIT_INGEST_CHUNK = '25';
  });

  afterAll(() => {
    delete process.env.KORTIX_AUDIT_INGEST_CHUNK;
  });

  function event(n: number) {
    return {
      event_id: n.toString(16).padStart(64, '0'),
      source_revision: `budget-${n}`,
      type: 'tool.execute.after',
      occurred_at: '2026-09-28T12:00:00.000Z',
      outcome: 'success',
      phase: 'completed',
      input_sha256: 'd'.repeat(64),
    };
  }

  /**
   * Drive the route inside a request context whose inbound audit scope carries
   * the given `startedAt` — exactly what the edge does in production
   * (`shared/audit-edge.ts`).
   */
  async function postWithStartedAt(count: number, startedAtMsAgo: number) {
    return runWithContext(
      'POST',
      `/${PROJECT_ID}/sessions/${SESSION_ID}/audit/events`,
      async () => {
        attachInboundAuditScope({
          owner: 'hono',
          method: 'POST',
          startedAt: Date.now() - startedAtMsAgo,
        });
        const response = await projectsApp.request(
          `/${PROJECT_ID}/sessions/${SESSION_ID}/audit/events`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ events: Array.from({ length: count }, (_, i) => event(i + 1)) }),
          },
        );
        return {
          status: response.status,
          retryAfter: response.headers.get('retry-after'),
          body: (await response.json()) as Record<string, unknown>,
        };
      },
    );
  }

  test('a request with no budget left for another chunk 503s before any insert', async () => {
    // 20s spent before the handler: ~5s left, under the ~23s one-chunk budget.
    const { status, retryAfter, body } = await postWithStartedAt(200, 20_000);

    expect(status).toBe(503);
    expect(retryAfter).toBe('5');
    expect(body).toMatchObject({ accepted: 200, inserted: 0, retry_after_seconds: 5 });
    expect(typeof body.error).toBe('string');
    // Nothing reached the database; the relay's spool keeps the whole batch.
    expect(insertStatements).toHaveLength(0);
  });

  test('a fresh request still writes a full 200-row batch', async () => {
    const { status, body } = await postWithStartedAt(200, 1_000);

    expect(status).toBe(200);
    expect(body).toMatchObject({ accepted: 200, inserted: 200 });
    expect(insertStatements.map((batch) => batch.length)).toEqual(
      Array.from({ length: 8 }, () => 25),
    );
  });

  test('stops at a chunk boundary once the budget is spent, keeping committed rows', async () => {
    // Chunk 1 is attempted (~23.8s left) and consumes 1.5s in a slow
    // statement; the ~22.3s left can no longer cover another chunk.
    insertDelayMs = 1_500;
    const { status, retryAfter, body } = await postWithStartedAt(200, 1_200);

    expect(status).toBe(503);
    expect(retryAfter).toBe('5');
    expect(body).toMatchObject({ accepted: 200, inserted: 25, retry_after_seconds: 5 });
    expect(insertStatements).toHaveLength(1);
  });

  test('a statement that never resolves answers the controlled 503 before the deadline', async () => {
    // The wait for an audit-pool backend has no bound of its own: postgres.js
    // has no acquire-queue timeout, and the pool is two backends shared with
    // the audit queue's own writes. Prod 2026-09-29, hours after the budget
    // check (KRTX-644) shipped: bursts of `…/audit/events` posts kept both
    // backends busy and ingest requests STILL died with the uncontrolled
    // `request exceeded the 25s server processing deadline` abort
    // mid-acquire — KRTX-522's deadline-503 lines, 08:48–09:09 UTC. The
    // chunk race (`boundChunkWrite`) cuts the write off at the request's
    // remaining budget instead.
    delete process.env.KORTIX_AUDIT_INGEST_CHUNK; // default: one statement per batch
    // The mocked INSERT resolves after 60s — far past every budget, the
    // shape of a statement queued behind a saturated audit pool. Without the
    // race the route hangs past the 25s deadline; with it, the route answers
    // the controlled contended 503 the relay already paces on.
    insertDelayMs = 60_000;
    const started = Date.now();
    const { status, retryAfter, body } = await postWithStartedAt(200, 1_000);
    const wallMs = Date.now() - started;

    expect(status).toBe(503);
    expect(retryAfter).toBe('5');
    expect(body).toMatchObject({ accepted: 200, inserted: 0, retry_after_seconds: 5 });
    // One statement was attempted, and the route answered inside the 25s
    // deadline the request-deadline middleware would otherwise abort at.
    expect(insertStatements).toHaveLength(1);
    expect(wallMs).toBeLessThan(24_000);
  }, 40_000);
});

describe('boundChunkWrite', () => {
  test('a statement that resolves inside its bound wins the race with its value', async () => {
    const started = Date.now();
    const result = await boundChunkWrite(
      Bun.sleep(20).then(() => 'landed'),
      5_000,
    );

    expect(result).toEqual({ timedOut: false, value: 'landed' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('a statement still pending at its bound loses the race and the caller moves on', async () => {
    const started = Date.now();
    const never = new Promise<never>(() => {});
    const result = await boundChunkWrite(never, 50);

    expect(result).toEqual({ timedOut: true });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('a statement that rejects inside its bound propagates the rejection', async () => {
    const boom = Promise.reject(new Error('statement timeout'));

    await expect(boundChunkWrite(boom, 5_000)).rejects.toThrow('statement timeout');
  });
});
