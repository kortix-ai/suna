/**
 * The read-path flush barrier stays bounded.
 *
 * `flushAuditEvents()` is the read-your-writes barrier of every audit read
 * route (`GET /v1/accounts/:id/audit`, the export, the project/session audit
 * lists). A flush chains onto the in-flight one and the audit pool's INSERT can
 * run for its whole 10s statement_timeout under cold-cache IO, so an unbounded
 * barrier parked a read route for the whole 25s request deadline: prod
 * 2026-09-28, `GET /v1/accounts/:id/audit` answered 16× 503 deadline aborts and
 * 3× 57014 statement timeouts in one minute (KRTX-631).
 *
 * The fix: read routes pass `waitMs`. These tests pin both sides:
 *   - bounded: a read route answers while the INSERT is slow, and the row still
 *     lands later (completeness survives);
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

const writtenBatches: AuditRow[][] = [];
/** While set, an INSERT starts but does not complete until `releaseGate()`. */
let gate: Promise<void> | null = null;
let releaseGate: () => void = () => {};
const holdInserts = () => {
  gate = new Promise<void>((resolve) => {
    releaseGate = () => {
      gate = null;
      resolve();
    };
  });
};

// The minimal surface the flush path touches. A cast: the real client is a
// Drizzle builder whose shape the queue never needs (see audit-queue.test.ts).
const gateableClient = {
  insert: () => ({
    values: (rows: AuditRow[]) => ({
      onConflictDoNothing: async () => {
        // A slow INSERT: the rows are only written once the gate opens.
        if (gate) await gate;
        writtenBatches.push([...rows]);
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
    writtenBatches.length = 0;
    gate = null;
  });

  afterEach(() => {
    delete process.env.KORTIX_AUDIT_SYNC;
    resetAuditQueueForTests();
  });

  test('a bounded barrier answers while the INSERT is slow, and the row still lands later', async () => {
    getAuditQueue(gateableClient).enqueue(rowForSession('audit-session-1'));
    holdInserts();

    const started = Date.now();
    await flushAuditEvents({ waitMs: 100 });
    const elapsed = Date.now() - started;

    // The read proceeds within the bound instead of riding the slow INSERT to the
    // 25s deadline.
    expect(elapsed).toBeLessThan(1_000);
    expect(writtenBatches).toHaveLength(0);

    // Completeness survives: the abandoned barrier's own drain writes the row.
    releaseGate();
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

  test('the default drain still waits for a slow queue (shutdown and test paths)', async () => {
    getAuditQueue(gateableClient).enqueue(rowForSession('audit-session-3'));
    holdInserts();

    let unboundedSettled = false;
    void flushAuditEvents().then(() => {
      unboundedSettled = true;
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    expect(unboundedSettled).toBe(false);

    releaseGate();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(unboundedSettled).toBe(true);
    expect(writtenBatches).toHaveLength(1);
  });
});
