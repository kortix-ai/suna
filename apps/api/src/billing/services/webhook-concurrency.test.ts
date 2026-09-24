import { describe, expect, test } from 'bun:test';
import { DEFAULT_DB_POOL_MAX } from '@kortix/db/connection-defaults';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  ACCOUNT_LOCK_MAX_HOLDERS,
  AccountLockTimeoutError,
  createAccountLock,
  type AccountLockDatabase,
} from './webhook-concurrency';

/**
 * A connection pool with the one property that matters here: a query waits,
 * with no timeout, until a connection is free (postgres.js has no acquire
 * timeout). A lock transaction holds one connection for its whole body.
 */
function simulatedPool(size: number) {
  let free = size;
  const waiters: Array<() => void> = [];
  const acquire = () =>
    new Promise<() => void>((resolve) => {
      const grant = () => {
        free -= 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          free += 1;
          waiters.shift()?.();
        });
      };
      if (free > 0) grant();
      else waiters.push(grant);
    });
  const database: AccountLockDatabase = {
    async transaction(fn) {
      const release = await acquire();
      try {
        return await fn({ execute: async () => undefined });
      } finally {
        release();
      }
    },
  };
  /** One statement on the shared pool, as the locked body issues them. */
  const query = async () => {
    const release = await acquire();
    await Bun.sleep(1);
    release();
  };
  return { database, query };
}

const STALL: unique symbol = Symbol('stall');

async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | typeof STALL> {
  return Promise.race([promise, Bun.sleep(ms).then((): typeof STALL => STALL)]);
}

/** N webhook bodies for N different accounts, each issuing two pool queries. */
function burst(lock: ReturnType<typeof createAccountLock>, query: () => Promise<void>, n: number) {
  return Promise.all(
    Array.from({ length: n }, (_, i) =>
      lock.withAccountLock(`acct-${i}`, async () => {
        await query();
        await query();
        return i;
      }),
    ),
  );
}

describe('withAccountLock never holds every pool connection', () => {
  test('uncapped holders (one lock connection per concurrent body) stall the pool: the hazard is real', async () => {
    const pool = simulatedPool(3);
    const uncapped = createAccountLock({
      database: pool.database,
      maxHolders: 3,
      acquireTimeoutMs: 60_000,
      lockTimeoutMs: 15_000,
    });

    const outcome = await settleWithin(burst(uncapped, pool.query, 3), 200);
    expect(outcome).toBe(STALL);
  });

  test('a burst larger than the pool completes when holders stay below the pool size', async () => {
    const pool = simulatedPool(3);
    const capped = createAccountLock({
      database: pool.database,
      maxHolders: 2,
      acquireTimeoutMs: 5_000,
      lockTimeoutMs: 15_000,
    });

    const outcome = await settleWithin(burst(capped, pool.query, 12), 2_000);
    expect(outcome).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(capped.holders()).toBe(0);
  });

  test('the production cap leaves pool connections free for the locked bodies', () => {
    expect(ACCOUNT_LOCK_MAX_HOLDERS).toBeGreaterThanOrEqual(1);
    expect(ACCOUNT_LOCK_MAX_HOLDERS).toBeLessThan(DEFAULT_DB_POOL_MAX);
  });

  test('a caller that cannot get a holder slot in time fails instead of waiting forever', async () => {
    const pool = simulatedPool(3);
    const lock = createAccountLock({
      database: pool.database,
      maxHolders: 1,
      acquireTimeoutMs: 50,
      lockTimeoutMs: 15_000,
    });

    let releaseFirst!: () => void;
    const first = lock.withAccountLock('acct-a', () => new Promise<void>((resolve) => { releaseFirst = resolve; }));
    await Bun.sleep(5);

    await expect(lock.withAccountLock('acct-b', async () => 'never')).rejects.toBeInstanceOf(AccountLockTimeoutError);

    releaseFirst();
    await first;
    expect(await lock.withAccountLock('acct-b', async () => 'ran')).toBe('ran');
    expect(lock.holders()).toBe(0);
  });

  test('a body that throws releases its holder slot', async () => {
    const pool = simulatedPool(3);
    const lock = createAccountLock({
      database: pool.database,
      maxHolders: 1,
      acquireTimeoutMs: 50,
      lockTimeoutMs: 15_000,
    });

    await expect(lock.withAccountLock('acct-a', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(lock.holders()).toBe(0);
    expect(await lock.withAccountLock('acct-a', async () => 'ok')).toBe('ok');
  });

  test('the lock transaction sets a lock_timeout before taking the advisory lock', async () => {
    const statements: string[] = [];
    const dialect = new PgDialect();
    const lock = createAccountLock({
      database: {
        async transaction(fn) {
          return fn({
            execute: async (query: any) => {
              statements.push(dialect.sqlToQuery(query).sql);
            },
          });
        },
      },
      maxHolders: 1,
      acquireTimeoutMs: 50,
      lockTimeoutMs: 15_000,
    });

    await lock.withAccountLock('acct-a', async () => undefined);
    expect(statements[0]).toContain('SET LOCAL lock_timeout');
    expect(statements[0]).toContain("'15000ms'");
    expect(statements[1]).toContain('pg_advisory_xact_lock');
  });
});
