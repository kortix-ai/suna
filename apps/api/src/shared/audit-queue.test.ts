import { describe, expect, test } from 'bun:test';
import {
  AUDIT_FLUSH_MAX_DEFAULT,
  AUDIT_FLUSH_MS_DEFAULT,
  AUDIT_QUEUE_MAX_DEFAULT,
  type AuditInsertClient,
  AuditQueue,
  type AuditRow,
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
  /** Blocks the write until released, so overlapping flushes can be observed. */
  gate: (enabled: boolean) => void;
  release: () => void;
}

function makeClient(): FakeClient {
  const batches: AuditRow[][] = [];
  let shouldFail = false;
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
            if (shouldFail) throw new Error('write failed');
          },
        }),
      }),
    } as unknown as AuditInsertClient,
    batches,
    conflictCalls: 0,
    failNext: (fail: boolean) => {
      shouldFail = fail;
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
});
