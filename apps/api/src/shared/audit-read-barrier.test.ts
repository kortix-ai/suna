/**
 * The read-path flush barrier stays bounded.
 *
 * `flushAuditEvents()` is the read-your-writes barrier of every audit read
 * route (`GET /v1/accounts/:id/audit`, the export, the project/session audit
 * lists). The queue's per-session serialize waits WITHOUT a timeout, so under
 * the per-session write convoy (the sandbox ingest vs the queue, see
 * audit-session-serial.ts) an unbounded barrier parked a read route for the
 * whole 25s request deadline: prod 2026-09-28, `GET /v1/accounts/:id/audit`
 * answered 16× 503 deadline aborts and 3× 57014 statement timeouts in one
 * minute while its workspace's audit ingest was contended (KRTX-631). The
 * barrier's INSERT started seconds into the request and then rode the audit
 * pool's 10s statement_timeout — the route's own SELECT never ran.
 *
 * The fix: read routes pass `waitMs`. These tests pin both sides:
 *   - bounded: a read route answers while the write convoy holds the session
 *     lock, and the row still lands later (completeness survives);
 *   - healthy: a bounded barrier still waits for a fast flush, so
 *     read-your-writes holds when the database is fine;
 *   - default (no options): the drain still waits for the queue — the
 *     shutdown and test paths keep their full flush.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  getAuditQueue,
  resetAuditQueueForTests,
  type AuditInsertClient,
  type AuditRow,
} from './audit-queue';
import { resetAuditSessionLocksForTest, withAuditSessionLock } from './audit-session-serial';

const writtenBatches: AuditRow[][] = [];
let gated = false;

// The minimal surface the flush path touches. A cast: the real client is a
// Drizzle builder whose shape the queue never needs (see audit-queue.test.ts).
const gateableClient = {
  insert: () => ({
    values: (rows: AuditRow[]) => ({
      onConflictDoNothing: async () => {
        writtenBatches.push([...rows]);
        // `gated` holds the statement like a convoyed INSERT: it starts
        // (pushing its rows) and never settles.
        if (gated) await new Promise<void>(() => {});
      },
    }),
  }),
} as unknown as AuditInsertClient;

mock.module('./db', () => ({ db: gateableClient }));
mock.module('./audit-db', () => ({ auditDb: () => gateableClient }));

const { AUDIT_READ_FLUSH_BARRIER_MS, flushAuditEvents } = await import('./audit');

function rowForSession(sessionId: string): AuditRow {
  return {
    accountId: '00000000-0000-4000-a000-000000000101',
    sessionId,
    action: 'test.action',
    resourceType: 'account',
  };
}

describe('the audit read barrier', () => {
  beforeEach(() => {
    process.env.KORTIX_AUDIT_SYNC = '0';
    resetAuditQueueForTests();
    resetAuditSessionLocksForTest();
    writtenBatches.length = 0;
    gated = false;
  });

  afterEach(() => {
    delete process.env.KORTIX_AUDIT_SYNC;
    resetAuditQueueForTests();
    resetAuditSessionLocksForTest();
  });

  test('a bounded barrier answers while a convoy holds the session lock, and the row still lands later', async () => {
    // Hold the in-process session lock like a contended ingest does, and make
    // the queue's INSERT wait for the same convoy.
    let releaseHolder!: () => void;
    void withAuditSessionLock('audit-session-1', () => new Promise<void>((r) => {
      releaseHolder = r;
    }));
    getAuditQueue(gateableClient).enqueue(rowForSession('audit-session-1'));
    gated = true;

    const started = Date.now();
    await flushAuditEvents({ waitMs: 100 });
    const elapsed = Date.now() - started;

    // The read proceeds within the bound instead of riding the convoy to the
    // 25s deadline. (Unbounded, this barrier only resolved when the holder
    // released AND the 10s statement finished — the prod 503 shape.)
    expect(elapsed).toBeLessThan(1_000);
    expect(writtenBatches).toHaveLength(0);

    // Completeness survives: release the convoy, and the abandoned barrier's
    // own drain writes the row in the background.
    gated = false;
    releaseHolder();
    getAuditQueue(gateableClient).flush();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(writtenBatches).toHaveLength(1);
  });

  test('a bounded barrier still waits for a healthy flush, so read-your-writes holds', async () => {
    getAuditQueue(gateableClient).enqueue(rowForSession('audit-session-2'));

    const started = Date.now();
    await flushAuditEvents({ waitMs: AUDIT_READ_FLUSH_BARRIER_MS });
    const elapsed = Date.now() - started;

    // The flush is fast when uncontended; the bounded barrier waited for it.
    expect(elapsed).toBeLessThan(AUDIT_READ_FLUSH_BARRIER_MS);
    expect(writtenBatches).toHaveLength(1);
    expect(writtenBatches[0]).toHaveLength(1);
  });

  test('the default drain still waits for a contended queue (shutdown and test paths)', async () => {
    let releaseHolder!: () => void;
    void withAuditSessionLock('audit-session-3', () => new Promise<void>((r) => {
      releaseHolder = r;
    }));
    getAuditQueue(gateableClient).enqueue(rowForSession('audit-session-3'));
    gated = true;

    let unboundedSettled = false;
    void flushAuditEvents().then(() => {
      unboundedSettled = true;
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    expect(unboundedSettled).toBe(false);

    gated = false;
    releaseHolder();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(unboundedSettled).toBe(true);
    expect(writtenBatches).toHaveLength(1);
  });
});
