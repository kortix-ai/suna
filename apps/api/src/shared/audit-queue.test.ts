import { describe, expect, test } from 'bun:test';
import {
  AUDIT_FLUSH_MAX_DEFAULT,
  AUDIT_FLUSH_MS_DEFAULT,
  AUDIT_QUEUE_MAX_DEFAULT,
  type AuditInsertClient,
  AuditQueue,
  type AuditRow,
  statementBatches,
} from './audit-queue';

function row(action: string): AuditRow {
  return { action, resourceType: 'account' } as AuditRow;
}

interface FakeClient {
  client: AuditInsertClient;
  /** One entry per INSERT statement, holding that statement's rows. */
  batches: AuditRow[][];
  /** Counts `.onConflictDoNothing()` calls — proves dedup is applied. */
  conflictCalls: number;
  failNext: (fail: boolean) => void;
  /** Fail only the statements whose rows match — one contended session. */
  failOn: (predicate: (rows: AuditRow[]) => boolean) => void;
  /** Blocks the write until released, so overlapping flushes can be observed. */
  gate: (enabled: boolean) => void;
  release: () => void;
}

function makeClient(): FakeClient {
  const batches: AuditRow[][] = [];
  let shouldFail = false;
  let failPredicate: ((rows: AuditRow[]) => boolean) | null = null;
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
            if (shouldFail || failPredicate?.(rows)) throw new Error('write failed');
          },
        }),
      }),
    } as unknown as AuditInsertClient,
    batches,
    conflictCalls: 0,
    failNext: (fail: boolean) => {
      shouldFail = fail;
    },
    failOn: (predicate: (rows: AuditRow[]) => boolean) => {
      failPredicate = predicate;
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
 * Essentia 2026-08-26. `kortix.audit_prepare_event` takes a per-session row
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
