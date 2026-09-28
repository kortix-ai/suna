import { describe, expect, test } from 'bun:test';
import {
  AUDIT_FLUSH_MAX_DEFAULT,
  AUDIT_FLUSH_MS_DEFAULT,
  AUDIT_QUEUE_MAX_DEFAULT,
  type AuditInsertClient,
  AuditQueue,
  type AuditRow,
  retryBackoffMs,
  statementBatches,
} from './audit-queue';
import { resetAuditSessionLocksForTest, withAuditSessionLock } from './audit-session-serial';

function row(action: string): AuditRow {
  return { action, resourceType: 'account' } as AuditRow;
}

/** The shape a failed `postgres.js`/Drizzle write actually carries: a `code`. */
function codedError(code: string, message = 'write failed'): Error {
  return Object.assign(new Error(message), { code });
}

interface FakeClient {
  client: AuditInsertClient;
  /** One entry per INSERT statement, holding that statement's rows. */
  batches: AuditRow[][];
  /** Counts `.onConflictDoNothing()` calls — proves dedup is applied. */
  conflictCalls: number;
  failNext: (fail: boolean) => void;
  /** Fail only the statements whose rows match — one contended session. */
  failOn: (predicate: (rows: AuditRow[]) => boolean, error?: unknown) => void;
  /** Fail every write with this error until called again with `null`. */
  failWith: (error: unknown | null) => void;
  /** Blocks the write until released, so overlapping flushes can be observed. */
  gate: (enabled: boolean) => void;
  release: () => void;
}

function makeClient(): FakeClient {
  const batches: AuditRow[][] = [];
  let shouldFail = false;
  let failPredicate: ((rows: AuditRow[]) => boolean) | null = null;
  let failPredicateError: unknown = new Error('write failed');
  let failError: unknown | null = null;
  let gated = false;
  let releaseFn: (() => void) | null = null;
  const state = {
    client: {
      insert: () => ({
        values: (rows: AuditRow[]) => ({
          onConflictDoNothing: async () => {
            state.conflictCalls += 1;
            batches.push([...rows]);
            if (gated) {
              await new Promise<void>((resolve) => {
                releaseFn = resolve;
              });
            }
            if (failError !== null) throw failError;
            if (shouldFail) throw new Error('write failed');
            if (failPredicate?.(rows)) throw failPredicateError;
          },
        }),
      }),
    } as unknown as AuditInsertClient,
    batches,
    conflictCalls: 0,
    failNext: (fail: boolean) => {
      shouldFail = fail;
    },
    failOn: (predicate: (rows: AuditRow[]) => boolean, error?: unknown) => {
      failPredicate = predicate;
      if (error !== undefined) failPredicateError = error;
    },
    failWith: (error: unknown | null) => {
      failError = error;
    },
    gate: (enabled: boolean) => {
      gated = enabled;
    },
    release: () => {
      releaseFn?.();
      releaseFn = null;
    },
  };
  return state;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('AuditQueue', () => {
  test('defaults match the documented tuning', () => {
    expect(AUDIT_FLUSH_MS_DEFAULT).toBe(250);
    expect(AUDIT_FLUSH_MAX_DEFAULT).toBe(100);
    expect(AUDIT_QUEUE_MAX_DEFAULT).toBe(5_000);
  });

  test('enqueue buffers without writing, and never blocks on I/O', () => {
    const fake = makeClient();
    const q = new AuditQueue(fake.client, { flushMs: 10_000 });
    q.enqueue(row('a'));
    q.enqueue(row('b'));
    // No await happened between enqueue and this assertion.
    expect(fake.batches).toHaveLength(0);
    expect(q.stats().queued).toBe(2);
    expect(q.stats().enqueued).toBe(2);
  });

  test('flush writes every buffered row in ONE multi-row insert', async () => {
    const fake = makeClient();
    const q = new AuditQueue(fake.client, { flushMs: 10_000, flushMax: 500 });
    for (const name of ['a', 'b', 'c']) q.enqueue(row(name));
    await q.flush();
    expect(fake.batches).toHaveLength(1);
    expect(fake.batches[0]).toHaveLength(3);
    expect(fake.batches[0]?.map((r) => r.action)).toEqual(['a', 'b', 'c']);
    expect(q.stats().written).toBe(3);
    expect(q.stats().queued).toBe(0);
  });

  test('every batch applies onConflictDoNothing, preserving source_record_id dedup', async () => {
    const fake = makeClient();
    const q = new AuditQueue(fake.client, { flushMs: 10_000, flushMax: 2 });
    for (const name of ['a', 'b', 'c', 'd']) q.enqueue(row(name));
    await q.flush();
    // 4 rows / flushMax 2 => 2 statements, each deduped.
    expect(fake.batches).toHaveLength(2);
    expect(fake.conflictCalls).toBe(2);
  });

  test('chunks a drain into flushMax-sized statements', async () => {
    const fake = makeClient();
    const q = new AuditQueue(fake.client, { flushMs: 10_000, flushMax: 3, queueMax: 100 });
    for (let i = 0; i < 7; i += 1) q.enqueue(row(`r${i}`));
    await q.flush();
    expect(fake.batches.map((b) => b.length)).toEqual([3, 3, 1]);
    expect(q.stats().written).toBe(7);
  });

  test('reaching flushMax triggers an immediate flush without waiting for the timer', async () => {
    const fake = makeClient();
    const q = new AuditQueue(fake.client, { flushMs: 10_000, flushMax: 3 });
    q.enqueue(row('a'));
    q.enqueue(row('b'));
    expect(fake.batches).toHaveLength(0);
    q.enqueue(row('c'));
    await q.flush();
    expect(fake.batches).toHaveLength(1);
    expect(fake.batches[0]).toHaveLength(3);
  });

  test('the timer flushes a partial batch on its own', async () => {
    const fake = makeClient();
    const q = new AuditQueue(fake.client, { flushMs: 15, flushMax: 500 });
    q.enqueue(row('a'));
    expect(fake.batches).toHaveLength(0);
    await sleep(60);
    expect(fake.batches).toHaveLength(1);
    expect(fake.batches[0]?.map((r) => r.action)).toEqual(['a']);
  });

  test('overflow drops the OLDEST rows and keeps the newest', async () => {
    const drops: Array<{ total: number; since: number }> = [];
    const fake = makeClient();
    const q = new AuditQueue(fake.client, {
      flushMs: 10_000,
      flushMax: 1_000,
      queueMax: 3,
      onDrop: (total, since) => drops.push({ total, since }),
    });
    for (const name of ['a', 'b', 'c', 'd', 'e']) q.enqueue(row(name));
    expect(q.stats().queued).toBe(3);
    expect(q.stats().dropped).toBe(2);
    await q.flush();
    expect(fake.batches[0]?.map((r) => r.action)).toEqual(['c', 'd', 'e']);
    expect(drops[0]?.total).toBeGreaterThan(0);
  });

  test('drop warnings are rate-limited to once per interval', () => {
    const drops: number[] = [];
    let clock = 1_000;
    const fake = makeClient();
    const q = new AuditQueue(fake.client, {
      flushMs: 10_000,
      flushMax: 1_000,
      queueMax: 1,
      dropLogIntervalMs: 60_000,
      now: () => clock,
      onDrop: (_total, since) => drops.push(since),
    });
    for (let i = 0; i < 10; i += 1) q.enqueue(row(`r${i}`));
    expect(drops).toHaveLength(1);
    expect(q.stats().dropped).toBe(9);

    clock += 60_001;
    for (let i = 0; i < 5; i += 1) q.enqueue(row(`s${i}`));
    expect(drops).toHaveLength(2);
    // Rate limiting suppresses the WARNING, never the accounting: the second
    // warning reports every drop since the first one (8 suppressed + 1 new),
    // so no dropped event goes unreported.
    expect(drops[1]).toBe(9);
    expect(q.stats().dropped).toBe(14);
  });

  test('a write failure never throws and never wedges the queue', async () => {
    const errors: number[] = [];
    const fake = makeClient();
    const q = new AuditQueue(fake.client, {
      flushMs: 10_000,
      onError: (_e, count) => errors.push(count),
    });
    fake.failNext(true);
    q.enqueue(row('a'));
    await q.flush(); // must resolve, not reject
    expect(errors).toEqual([1]);
    expect(q.stats().failed).toBe(1);
    expect(q.stats().written).toBe(0);

    // The queue still accepts and writes afterwards.
    fake.failNext(false);
    q.enqueue(row('b'));
    await q.flush();
    expect(q.stats().written).toBe(1);
  });

  test('concurrent flushes share one drain instead of double-writing', async () => {
    const fake = makeClient();
    const q = new AuditQueue(fake.client, { flushMs: 10_000, flushMax: 100 });
    fake.gate(true);
    q.enqueue(row('a'));
    const first = q.flush();
    const second = q.flush();
    expect(second).toBe(first);
    fake.release();
    fake.gate(false);
    await first;
    expect(fake.batches).toHaveLength(1);
    expect(q.stats().written).toBe(1);
  });

  test('shutdown drains the tail so a SIGTERM loses nothing', async () => {
    const fake = makeClient();
    const q = new AuditQueue(fake.client, { flushMs: 10_000, flushMax: 500 });
    q.enqueue(row('a'));
    q.enqueue(row('b'));
    await q.shutdown();
    expect(fake.batches).toHaveLength(1);
    expect(fake.batches[0]).toHaveLength(2);
    expect(q.stats().queued).toBe(0);
    expect(q.stats().written).toBe(2);
  });

  test('rows enqueued during a flush are written by a follow-up drain', async () => {
    const fake = makeClient();
    const q = new AuditQueue(fake.client, { flushMs: 10, flushMax: 100 });
    fake.gate(true);
    q.enqueue(row('a'));
    const inFlight = q.flush();
    q.enqueue(row('b'));
    fake.release();
    fake.gate(false);
    await inFlight;
    await sleep(40);
    expect(fake.batches.flat().map((r) => r.action)).toEqual(['a', 'b']);
  });

  test('a flush waits only for rows queued before that call', async () => {
    const fake = makeClient();
    const q = new AuditQueue(fake.client, { flushMs: 10_000, flushMax: 100 });
    fake.gate(true);
    q.enqueue(row('a'));
    void q.flush();

    q.enqueue(row('b'));
    const barrier = q.flush();
    q.enqueue(row('c'));

    fake.release();
    fake.gate(false);
    await barrier;

    expect(fake.batches.flat().map((r) => r.action)).toEqual(['a', 'b']);
    expect(q.stats().queued).toBe(1);
    await q.shutdown();
  });
});

/**
 * SampleCo 2026-08-26. `kortix.audit_prepare_event` takes a per-session row
 * lock on `kortix.audit_session_sequences` that PostgreSQL holds until COMMIT,
 * so a statement built in arrival order held EVERY session it touched. Measured
 * against a 5.09M-row `audit_events`: a 100-row cross-session statement blocked
 * a same-session ingest to a hard 57014 at 10,004.957 ms, while a same-shaped
 * single-session statement left a different session's insert at 2.6 ms.
 */
describe('statementBatches', () => {
  function sessionRow(sessionId: string | null, action: string): AuditRow {
    return { action, resourceType: 'session', sessionId } as unknown as AuditRow;
  }

  test('never puts two sessions in one statement', () => {
    const batches = statementBatches(
      [
        sessionRow('a', '1'),
        sessionRow('b', '2'),
        sessionRow('a', '3'),
        sessionRow('c', '4'),
        sessionRow('b', '5'),
      ],
      100,
    );

    for (const batch of batches) {
      expect(new Set(batch.map((r) => (r as { sessionId: string }).sessionId)).size).toBe(1);
    }
    expect(batches).toHaveLength(3);
  });

  test('preserves arrival order within a session — the only order session_sequence is defined over', () => {
    const batches = statementBatches(
      [sessionRow('a', '1'), sessionRow('b', 'x'), sessionRow('a', '2'), sessionRow('a', '3')],
      100,
    );

    const first = batches.find((b) => (b[0] as { sessionId: string }).sessionId === 'a');
    expect(first?.map((r) => r.action)).toEqual(['1', '2', '3']);
  });

  test('still caps a single session at the statement maximum', () => {
    const rows = Array.from({ length: 7 }, (_, i) => sessionRow('a', String(i)));

    expect(statementBatches(rows, 3).map((b) => b.length)).toEqual([3, 3, 1]);
  });

  test('rows with no session share one group and take no session lock', () => {
    const batches = statementBatches(
      [sessionRow(null, '1'), sessionRow('a', '2'), sessionRow(undefined as never, '3')],
      100,
    );

    const sessionless = batches.find((b) => !(b[0] as { sessionId: string | null }).sessionId);
    expect(sessionless?.map((r) => r.action)).toEqual(['1', '3']);
  });

  test('every row survives the split', () => {
    const rows = Array.from({ length: 250 }, (_, i) => sessionRow(`s${i % 7}`, String(i)));

    const batches = statementBatches(rows, 10);

    expect(batches.flat()).toHaveLength(250);
    expect(new Set(batches.flat().map((r) => r.action)).size).toBe(250);
  });
});

describe('AuditQueue statement isolation', () => {
  test('a flush that spans sessions writes one statement per session', async () => {
    const fake = makeClient();
    const queue = new AuditQueue(fake.client, { flushMax: 100, flushMs: 10_000 });

    for (const sessionId of ['s1', 's2', 's1', 's3']) {
      queue.enqueue({ action: 'a', resourceType: 'session', sessionId } as unknown as AuditRow);
    }
    await queue.flush();

    expect(fake.batches).toHaveLength(3);
    expect(fake.batches.map((b) => b.length).sort()).toEqual([1, 1, 2]);
    expect(queue.stats()).toMatchObject({ written: 4, failed: 0, flushes: 3 });
  });

  test('one contended session cannot drop another session rows', async () => {
    const fake = makeClient();
    const errors: number[] = [];
    const queue = new AuditQueue(fake.client, {
      flushMax: 100,
      flushMs: 10_000,
      onError: (_error, rowCount) => errors.push(rowCount),
    });

    fake.failOn((rows) => (rows[0] as unknown as { sessionId: string }).sessionId === 's2');
    for (const sessionId of ['s1', 's2', 's3']) {
      queue.enqueue({ action: 'a', resourceType: 'session', sessionId } as unknown as AuditRow);
    }
    await queue.flush();

    expect(errors).toEqual([1]);
    expect(queue.stats()).toMatchObject({ written: 2, failed: 1 });
  });
});

/**
 * The same-process convoy (prod 2026-09-26).
 *
 * `POST /v1/projects/:p/sessions/:s/audit/events` is written twice by the same
 * process for the SAME session: the ingest route's chunk and the request's own
 * inbound audit row the queue flushes. Both take the session's
 * `audit_session_sequences` row lock. Without the in-process lock the queue's
 * row lost that race at the pool's 2.5 s `lock_timeout` (55P03) and the batch
 * was dropped (`[audit] Dropped a batch …`); the ingest rode its 10 s
 * `statement_timeout` to 57014 and answered 503.
 */
describe('AuditQueue per-session serialization', () => {
  test('a flush for a session waits for another in-process writer of the SAME session', async () => {
    resetAuditSessionLocksForTest();
    const fake = makeClient();
    let releaseRoute!: () => void;
    const routeHeld = withAuditSessionLock(
      's1',
      () =>
        new Promise<void>((resolve) => {
          releaseRoute = resolve;
        }),
    );

    const queue = new AuditQueue(fake.client, { flushMs: 10_000, flushMax: 100 });
    queue.enqueue({ action: 'a', resourceType: 'session', sessionId: 's1' } as unknown as AuditRow);
    const flush = queue.flush();

    // The route-like writer holds the session lock, so the queue must NOT have
    // opened a competing Postgres insert yet.
    await sleep(20);
    expect(fake.batches).toHaveLength(0);

    releaseRoute();
    await routeHeld;
    await flush;

    expect(fake.batches).toHaveLength(1);
    expect(queue.stats()).toMatchObject({ written: 1, failed: 0 });
  });

  test('a DIFFERENT session is not blocked by a held session lock', async () => {
    resetAuditSessionLocksForTest();
    const fake = makeClient();
    let releaseHeld!: () => void;
    const held = withAuditSessionLock(
      'busy',
      () =>
        new Promise<void>((resolve) => {
          releaseHeld = resolve;
        }),
    );

    const queue = new AuditQueue(fake.client, { flushMs: 10_000, flushMax: 100 });
    queue.enqueue({
      action: 'a',
      resourceType: 'session',
      sessionId: 'other',
    } as unknown as AuditRow);
    await queue.flush();

    expect(fake.batches).toHaveLength(1);
    releaseHeld();
    await held;
  });

  test('passes the batch session to the serializer; session-less rows bypass it', async () => {
    const seen: string[] = [];
    const fake = makeClient();
    const queue = new AuditQueue(fake.client, {
      flushMs: 10_000,
      flushMax: 100,
      serialize: async (sessionId, fn) => {
        seen.push(sessionId);
        await fn();
      },
    });

    queue.enqueue({ action: 'a', resourceType: 'session', sessionId: 's1' } as unknown as AuditRow);
    queue.enqueue(row('no-session'));
    await queue.flush();

    expect(seen).toEqual(['s1']);
    expect(fake.batches).toHaveLength(2);
  });
});

describe('retryBackoffMs', () => {
  test('grows exponentially and caps at retryMaxMs', () => {
    expect(retryBackoffMs(1, 200, 5_000, 0)).toBe(100); // half of the base
    expect(retryBackoffMs(1, 200, 5_000, 1)).toBe(200); // full base
    expect(retryBackoffMs(4, 200, 5_000, 0)).toBe(800); // 200*2^3=1600, half=800
    expect(retryBackoffMs(10, 200, 5_000, 1)).toBe(5_000); // capped, not 200*2^9
  });

  test('never returns a near-zero delay that would re-hammer the lock', () => {
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      expect(retryBackoffMs(attempt, 200, 5_000, 0)).toBeGreaterThan(0);
    }
  });
});

/**
 * The actual production incident (`[audit] Dropped a batch of 1 events after
 * a write failure: sqlstate=55P03 canceling statement due to lock timeout`):
 * hundreds per hour, 100% lock-timeout contention, 0% a real data defect. The
 * queue dropped every one of them. This is the regression suite for that bug.
 */
describe('AuditQueue never drops a contended batch', () => {
  test('55P03 (lock_timeout) is requeued for the next flush, not dropped', async () => {
    const fake = makeClient();
    const errors: number[] = [];
    const retries: Array<{ rowCount: number; attempt: number }> = [];
    const q = new AuditQueue(fake.client, {
      flushMs: 10_000,
      onError: (_e, count) => errors.push(count),
      onRetry: (_error, rowCount, attempt) => retries.push({ rowCount, attempt }),
    });

    fake.failWith(codedError('55P03', 'canceling statement due to lock timeout'));
    q.enqueue(row('a'));
    await q.flush();

    // Never dead-lettered, never counted as an overflow drop.
    expect(errors).toEqual([]);
    expect(q.stats().failed).toBe(0);
    expect(q.stats().dropped).toBe(0);
    expect(q.stats().written).toBe(0);
    expect(q.stats().contended).toBe(1);
    // The row goes back into the buffer, in original order, for a later try.
    expect(q.stats().queued).toBe(1);
    expect(retries).toEqual([{ rowCount: 1, attempt: 1 }]);

    // Once the database recovers, the SAME row is written — it was never lost.
    fake.failWith(null);
    await q.flush();
    expect(q.stats().written).toBe(1);
    expect(q.stats().queued).toBe(0);
    expect(fake.batches.map((b) => b.map((r) => r.action))).toEqual([['a'], ['a']]);
  });

  test('every documented contention SQLSTATE is requeued, not dropped', async () => {
    for (const code of ['57014', '55P03', '40001', '40P01', '57P03', '08006', '53300']) {
      const fake = makeClient();
      const errors: number[] = [];
      const q = new AuditQueue(fake.client, {
        flushMs: 10_000,
        onError: (_e, c) => errors.push(c),
      });
      fake.failWith(codedError(code));
      q.enqueue(row('a'));
      await q.flush();
      expect(errors).toEqual([]);
      expect(q.stats().failed).toBe(0);
      expect(q.stats().queued).toBe(1);
    }
  });

  test('a driver-level connection code (no SQLSTATE) is requeued too', async () => {
    const fake = makeClient();
    const errors: number[] = [];
    const q = new AuditQueue(fake.client, { flushMs: 10_000, onError: (_e, c) => errors.push(c) });
    fake.failWith(codedError('ECONNREFUSED'));
    q.enqueue(row('a'));
    await q.flush();
    expect(errors).toEqual([]);
    expect(q.stats().queued).toBe(1);
  });

  test('a genuinely poison batch (a data error) is still dead-lettered once, not retried forever', async () => {
    const fake = makeClient();
    const errors: number[] = [];
    const retries: unknown[] = [];
    const q = new AuditQueue(fake.client, {
      flushMs: 10_000,
      onError: (_e, count) => errors.push(count),
      onRetry: () => retries.push(true),
    });

    fake.failWith(codedError('23505', 'duplicate key value violates unique constraint'));
    q.enqueue(row('a'));
    await q.flush();

    expect(errors).toEqual([1]);
    expect(retries).toEqual([]);
    expect(q.stats().failed).toBe(1);
    expect(q.stats().contended).toBe(0);
    expect(q.stats().queued).toBe(0); // not requeued — retrying can never succeed
  });

  test('one contended session does not block another session in the same flush', async () => {
    const fake = makeClient();
    const q = new AuditQueue(fake.client, { flushMs: 10_000, flushMax: 100 });
    fake.failOn(
      (rows) => (rows[0] as unknown as { sessionId: string }).sessionId === 's2',
      codedError('55P03'),
    );

    for (const sessionId of ['s1', 's2', 's3']) {
      q.enqueue({ action: 'a', resourceType: 'session', sessionId } as unknown as AuditRow);
    }
    await q.flush();

    // s1 and s3 wrote cleanly; s2 alone is buffered for retry.
    expect(q.stats().written).toBe(2);
    expect(q.stats().queued).toBe(1);
    expect(q.stats().failed).toBe(0);
  });

  test('backs off exponentially instead of retrying every flushMs', async () => {
    const fake = makeClient();
    const q = new AuditQueue(fake.client, {
      flushMs: 5,
      retryBaseMs: 100,
      retryMaxMs: 2_000,
      random: () => 0, // pins the delay to the deterministic floor (half the cap)
    });
    fake.failWith(codedError('55P03'));
    q.enqueue(row('a'));
    await q.flush(); // first attempt fails and schedules the backed-off retry

    // Without backoff the 5ms timer would have retried several times by now.
    await sleep(30);
    expect(fake.batches).toHaveLength(1);

    // The backoff floor for attempt 1 is retryBaseMs/2 = 50ms; well past it.
    await sleep(120);
    expect(fake.batches.length).toBeGreaterThanOrEqual(2);
  });

  test('reaching flushMax during an active backoff does not bypass it', async () => {
    const fake = makeClient();
    const q = new AuditQueue(fake.client, {
      // Small enough that, without the backoff guard, hitting flushMax would
      // fire an unthrottled flush well before the backoff window elapses.
      flushMs: 20,
      flushMax: 2,
      retryBaseMs: 300,
      retryMaxMs: 2_000,
      random: () => 0,
    });
    fake.failWith(codedError('55P03'));
    q.enqueue(row('a'));
    await q.flush(); // contended; backoff window now active
    fake.failWith(null);

    // These two enqueues hit flushMax immediately. Without the backoff guard
    // this would trigger an unthrottled flush and re-hammer the same lock.
    q.enqueue(row('b'));
    q.enqueue(row('c'));
    await sleep(20);
    expect(fake.batches).toHaveLength(1); // only the first (failed) attempt so far

    await sleep(300);
    expect(fake.batches.length).toBeGreaterThanOrEqual(2);
    expect(q.stats().written).toBe(3); // a, b, c all eventually land
  });

  test('shutdown retries a contended batch, respecting backoff, before giving up at its deadline', async () => {
    const fake = makeClient();
    fake.failWith(codedError('55P03'));
    const q = new AuditQueue(fake.client, {
      flushMs: 10_000,
      retryBaseMs: 5,
      retryMaxMs: 20,
      shutdownDeadlineMs: 200,
      sleep: async (ms) => {
        await new Promise((r) => setTimeout(r, Math.min(ms, 5)));
      },
    });
    q.enqueue(row('a'));

    await q.shutdown();

    // The database never recovered: the row is still buffered, not silently
    // dropped, and the loop terminated instead of hanging forever.
    expect(q.stats().queued).toBe(1);
    expect(q.stats().failed).toBe(0);
    expect(fake.batches.length).toBeGreaterThan(1); // it did retry more than once
  });

  test('shutdown drains a contended batch once the database recovers mid-drain', async () => {
    const fake = makeClient();
    let attempts = 0;
    const original = fake.failWith;
    void original;
    fake.failWith(codedError('55P03'));
    const q = new AuditQueue(fake.client, {
      flushMs: 10_000,
      retryBaseMs: 5,
      retryMaxMs: 10,
      shutdownDeadlineMs: 5_000,
      sleep: async (ms) => {
        attempts += 1;
        if (attempts === 2) fake.failWith(null); // recovers after the 2nd wait
        await new Promise((r) => setTimeout(r, Math.min(ms, 5)));
      },
    });
    q.enqueue(row('a'));

    await q.shutdown();

    expect(q.stats().written).toBe(1);
    expect(q.stats().queued).toBe(0);
  });
});

/**
 * A request-path reader drains the queue so it observes every event already
 * emitted (read-your-writes). That barrier must never hold the request past
 * the server's processing deadline, which is what happened to
 * `GET /v1/accounts/:id/audit` on 2026-09-28: an unbounded `flush()` waited on
 * the audit-ingest session locks until the route hit its 25 s deadline (503)
 * or had its own `audit_events` SELECT cancelled at `statement_timeout`
 * (500, SQLSTATE 57014). `flush({ timeoutMs })` is the fix: it resolves at the
 * budget while the drain keeps running in the background, and the rows are
 * still written once the contention clears. The queue never loses a row.
 */
describe('AuditQueue bounded request-path flush', () => {
  test('a bounded flush resolves at its budget while a session lock is held', async () => {
    resetAuditSessionLocksForTest();
    const fake = makeClient();
    let releaseHolder!: () => void;
    const holder = withAuditSessionLock(
      's1',
      () =>
        new Promise<void>((resolve) => {
          releaseHolder = resolve;
        }),
    );

    const q = new AuditQueue(fake.client, { flushMs: 10_000, flushMax: 100 });
    q.enqueue({ action: 'a', resourceType: 'session', sessionId: 's1' } as unknown as AuditRow);

    const started = Date.now();
    await q.flush({ timeoutMs: 25 });

    // The read returned at its budget; the insert had not run (blocked lock).
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fake.batches).toHaveLength(0);

    // Release the lock; the background drain finishes and the row is written.
    releaseHolder();
    await holder;
    await q.flush();
    expect(q.stats().written).toBe(1);
    expect(q.stats().failed).toBe(0);
    expect(fake.batches).toHaveLength(1);
  });

  test('an unbounded flush still waits for the drain', async () => {
    resetAuditSessionLocksForTest();
    const fake = makeClient();
    let releaseHolder!: () => void;
    const holder = withAuditSessionLock(
      's2',
      () =>
        new Promise<void>((resolve) => {
          releaseHolder = resolve;
        }),
    );

    const q = new AuditQueue(fake.client, { flushMs: 10_000, flushMax: 100 });
    q.enqueue({ action: 'a', resourceType: 'session', sessionId: 's2' } as unknown as AuditRow);

    let settled = false;
    const flush = q.flush().then(() => {
      settled = true;
    });
    await sleep(40);
    expect(settled).toBe(false); // still waiting on the held session lock

    releaseHolder();
    await holder;
    await flush;
    expect(settled).toBe(true);
    expect(q.stats().written).toBe(1);
  });
});
