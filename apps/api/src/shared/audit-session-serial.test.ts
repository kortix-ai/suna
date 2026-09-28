/**
 * The process-local per-session audit lock.
 *
 * Prod evidence this exists for (2026-09-26): `POST
 * /v1/projects/:p/sessions/:s/audit/events` answered 503 (`57014`, statement
 * timeout) while the audit queue dropped rows with `55P03` (lock timeout), both
 * for the same session — the request's own inbound audit row raced the ingest
 * batch for that session's `audit_session_sequences` row lock.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  AuditSessionLockTimeoutError,
  auditSessionLockCountForTest,
  isAuditSessionLockTimeout,
  resetAuditSessionLocksForTest,
  withAuditSessionLock,
} from './audit-session-serial';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  resetAuditSessionLocksForTest();
});

describe('withAuditSessionLock', () => {
  test('serializes two writers of the SAME session', async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const writer = (label: string) =>
      withAuditSessionLock('s1', async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(`${label}:start`);
        await sleep(12);
        order.push(`${label}:end`);
        active -= 1;
      });

    await Promise.all([writer('a'), writer('b'), writer('c')]);

    expect(maxActive).toBe(1);
    // FIFO: a completes before b starts, b before c.
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  test('does not serialize DIFFERENT sessions', async () => {
    let active = 0;
    let maxActive = 0;
    const writer = (sessionId: string) =>
      withAuditSessionLock(sessionId, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(15);
        active -= 1;
      });

    await Promise.all([writer('s1'), writer('s2'), writer('s3')]);

    expect(maxActive).toBe(3);
  });

  test('rows with no session take no lock', async () => {
    let active = 0;
    let maxActive = 0;
    const writer = (sessionId: string | null | undefined) =>
      withAuditSessionLock(sessionId, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(10);
        active -= 1;
      });

    await Promise.all([writer(null), writer(undefined), writer(''), writer('  ')]);

    expect(maxActive).toBe(4);
    expect(auditSessionLockCountForTest()).toBe(0);
  });

  test('a bounded wait throws AuditSessionLockTimeoutError instead of running past its budget', async () => {
    let release!: () => void;
    const holder = withAuditSessionLock(
      's1',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const startedAt = Date.now();
    let error: unknown = null;
    try {
      await withAuditSessionLock('s1', async () => {}, { timeoutMs: 25 });
    } catch (caught) {
      error = caught;
    }
    const waited = Date.now() - startedAt;

    expect(isAuditSessionLockTimeout(error)).toBe(true);
    expect(error).toBeInstanceOf(AuditSessionLockTimeoutError);
    expect((error as AuditSessionLockTimeoutError).sessionId).toBe('s1');
    expect(waited).toBeLessThan(500);

    release();
    await holder;
  });

  test('an unbounded wait acquires once the holder releases', async () => {
    let release!: () => void;
    const holder = withAuditSessionLock(
      's1',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let ran = false;
    const waiter = withAuditSessionLock('s1', async () => {
      ran = true;
    });

    await sleep(15);
    expect(ran).toBe(false);

    release();
    await holder;
    await waiter;
    expect(ran).toBe(true);
  });

  test('a rejected body propagates and still releases the lock', async () => {
    const boom = new Error('insert failed');
    await expect(
      withAuditSessionLock('s1', async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    // The next writer is not wedged behind a lock the failure left held.
    let ran = false;
    await withAuditSessionLock('s1', async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  test('a timed-out waiter does not wedge the writers behind it', async () => {
    let release!: () => void;
    const holder = withAuditSessionLock(
      's1',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    await withAuditSessionLock('s1', async () => {}, { timeoutMs: 10 }).catch(() => {});

    let ran = false;
    const after = withAuditSessionLock('s1', async () => {
      ran = true;
    });
    release();
    await holder;
    await after;
    expect(ran).toBe(true);
  });

  test('frees its gate so the map does not grow with every session', async () => {
    for (let i = 0; i < 50; i += 1) {
      await withAuditSessionLock(`session-${i}`, async () => {});
    }
    expect(auditSessionLockCountForTest()).toBe(0);
  });

  test('frees its gate after a failure and after a timeout', async () => {
    await withAuditSessionLock('s1', async () => {
      throw new Error('boom');
    }).catch(() => {});
    expect(auditSessionLockCountForTest()).toBe(0);

    let release!: () => void;
    const holder = withAuditSessionLock(
      's2',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await withAuditSessionLock('s2', async () => {}, { timeoutMs: 10 }).catch(() => {});
    release();
    await holder;
    expect(auditSessionLockCountForTest()).toBe(0);
  });

  test('recognizes the timeout marker through a wrapped error, the way callers see it', () => {
    const inner = new AuditSessionLockTimeoutError('s1', 12_000);
    expect(isAuditSessionLockTimeout(inner)).toBe(true);
    expect(isAuditSessionLockTimeout(Object.assign(new Error('wrapped'), { cause: inner }))).toBe(
      false,
    );
    expect(isAuditSessionLockTimeout({ code: 'AUDIT_SESSION_LOCK_TIMEOUT' })).toBe(true);
    expect(isAuditSessionLockTimeout(new Error('nope'))).toBe(false);
    expect(isAuditSessionLockTimeout(null)).toBe(false);
  });
});
