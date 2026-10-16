import { describe, test, expect } from 'bun:test';
import { sql } from 'drizzle-orm';
import { createDb, connectRetry, isConnectTimeoutError } from './client';

describe('createDb input validation', () => {
  test('throws when the database url is an empty string', () => {
    expect(() => createDb('')).toThrow('DATABASE_URL is required');
  });

  test('does not throw synchronously for a well-formed connection string', () => {
    expect(() => createDb('postgres://user:pass@127.0.0.1:5432/does_not_connect_lazily')).not.toThrow();
  });

  test('returns a drizzle database client object', () => {
    const client = createDb('postgres://user:pass@127.0.0.1:5432/lazy');
    expect(client).toBeDefined();
    expect(typeof client.select).toBe('function');
  });
});

// ─── instrumentSql ──────────────────────────────────────────────────────────
// Drives the API's `Server-Timing: db;dur=…;desc="n=…"`. A fake postgres.js
// client stands in for the wire: `unsafe` returns a LAZY promise subclass that
// only runs on its first `then`, exactly like postgres.js's `Query`.

import { instrumentSql } from './client';

class LazyQuery extends Promise<unknown> {
  static get [Symbol.species]() {
    return Promise;
  }
  runs = 0;
  private settle!: (value: unknown) => void;
  private fail!: (error: unknown) => void;
  constructor(private readonly outcome: { value?: unknown; error?: unknown }) {
    let settle!: (value: unknown) => void;
    let fail!: (error: unknown) => void;
    super((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    this.settle = settle;
    this.fail = fail;
  }
  values() {
    return this;
  }
  override then<A = unknown, B = never>(
    onfulfilled?: ((value: unknown) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    if (this.runs++ === 0) {
      setTimeout(() => ('error' in this.outcome ? this.fail(this.outcome.error) : this.settle(this.outcome.value)), 5);
    }
    return super.then(onfulfilled, onrejected);
  }
}

function recorder() {
  const events: string[] = [];
  let open = 0;
  const onQuery = () => {
    open++;
    events.push('start');
    return () => {
      open--;
      events.push('end');
    };
  };
  return { events, onQuery, open: () => open };
}

describe('instrumentSql', () => {
  test('reports one operation per awaited statement, from dispatch to settle', async () => {
    const rec = recorder();
    const fake = { unsafe: (_statement: string) => new LazyQuery({ value: [1] }) };
    const sql = instrumentSql(fake, rec.onQuery);

    const query = sql.unsafe('select 1');
    expect(rec.events).toEqual([]); // lazy: nothing dispatched yet
    // Plain `await`, like Drizzle: bun's `expect().resolves` reads the promise's
    // internal state without calling `then`, so it would never start the query.
    expect(await query.values()).toEqual([1]);

    expect(rec.events).toEqual(['start', 'end']);
    expect((query as LazyQuery).runs).toBe(1); // observing it never re-runs it
  });

  test('a failing statement is still closed and its rejection still reaches the caller', async () => {
    const rec = recorder();
    const fake = { unsafe: (_statement: string) => new LazyQuery({ error: new Error('statement timeout') }) };
    const sql = instrumentSql(fake, rec.onQuery);

    let caught: unknown;
    try {
      await sql.unsafe('select pg_sleep(99)');
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toBe('statement timeout');
    expect(rec.events).toEqual(['start', 'end']);
    expect(rec.open()).toBe(0);
  });

  test('a transaction is one operation and its inner statements are observed too', async () => {
    const rec = recorder();
    const inner = { unsafe: (_statement: string) => new LazyQuery({ value: [] }) };
    const fake = {
      begin: async (callback: (tx: typeof inner) => Promise<unknown>) => callback(inner),
    };
    const sql = instrumentSql(fake, rec.onQuery);

    await sql.begin(async (tx) => {
      await tx.unsafe('insert 1');
      await tx.unsafe('insert 2');
    });

    expect(rec.events).toEqual(['start', 'start', 'end', 'start', 'end', 'end']);
    expect(rec.open()).toBe(0);
  });

  test('everything that is not a query entry point passes through untouched', () => {
    const options = { parsers: {} };
    const fake = { options, unsafe: (_statement: string) => new LazyQuery({ value: [] }) };
    const sql = instrumentSql(fake, recorder().onQuery);
    expect(sql.options).toBe(options);
  });
});

// ─── connectRetry ───────────────────────────────────────────────────────────
// postgres.js has no driver-level retry: when a connection attempt exceeds
// `connect_timeout`, the query that drew the connection rejects with a plain
// Error (`code: 'CONNECT_TIMEOUT'`) and is gone. The statement never reached
// the server, so exactly one fresh attempt on a new connection is safe.

// A query whose result depends on the `.values()` flag, like postgres.js: the
// same statement resolves to array rows when flagged, object rows otherwise.
class ShapeQuery extends Promise<unknown> {
  static get [Symbol.species]() {
    return Promise;
  }
  runs = 0;
  isRaw: unknown = null;
  private settle!: (value: unknown) => void;
  private fail!: (error: unknown) => void;
  constructor(private readonly outcome: { value?: unknown; error?: unknown }) {
    let settle!: (value: unknown) => void;
    let fail!: (error: unknown) => void;
    super((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    this.settle = settle;
    this.fail = fail;
  }
  values() {
    this.isRaw = 'values';
    return this;
  }
  // biome-ignore lint/suspicious/noThenProperty: the fake must intercept the settle path like postgres.js Query.
  override then<A = unknown, B = never>(
    onfulfilled?: ((value: unknown) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    if (this.runs++ === 0) {
      setTimeout(() => {
        if ('error' in this.outcome) return this.fail(this.outcome.error);
        if (this.isRaw === 'values') return this.settle([[1, 'a']]);
        return this.settle(this.outcome.value ?? []);
      }, 5);
    }
    return super.then(onfulfilled, onrejected);
  }
}

const connectTimeout = () =>
  Object.assign(new Error('write CONNECT_TIMEOUT db.<redacted>.supabase.co:5432'), {
    code: 'CONNECT_TIMEOUT',
  });

function scriptedSql(script: Array<{ value?: unknown; error?: unknown }>) {
  let attempts = 0;
  const sql = {
    unsafe: (_statement: string) => new ShapeQuery(script[attempts++] ?? { value: [] }),
  };
  return { sql, attempts: () => attempts };
}

describe('connectRetry', () => {
  test('retries once when the connection never established, and the fresh attempt wins', async () => {
    const { sql, attempts } = scriptedSql([{ error: connectTimeout() }, { value: ['ok'] }]);
    expect(await connectRetry(sql).unsafe('select 1')).toEqual(['ok']);
    expect(attempts()).toBe(2);
  });

  test('an error the server produced is not retried', async () => {
    const { sql, attempts } = scriptedSql([{ error: new Error('syntax error at or near "oops"') }]);
    let caught: unknown;
    try {
      await connectRetry(sql).unsafe('select oops');
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toContain('syntax error');
    expect(attempts()).toBe(1);
  });

  test('gives up after one retry when the database stays unreachable', async () => {
    const { sql, attempts } = scriptedSql([
      { error: connectTimeout() },
      { error: connectTimeout() },
      { value: ['never'] },
    ]);
    let caught: unknown;
    try {
      await connectRetry(sql).unsafe('select 1');
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toContain('CONNECT_TIMEOUT');
    expect(attempts()).toBe(2);
  });

  test('a retried-wrapped statement starts the underlying query only once per subscriber generation', async () => {
    const { sql } = scriptedSql([{ value: ['ok'] }]);
    const query = connectRetry(sql).unsafe('select 1');
    expect(await Promise.resolve(query)).toEqual(['ok']);
    expect(await Promise.resolve(query)).toEqual(['ok']); // second subscriber rides the same attempt
  });

  test('the retried attempt keeps the .values() result shape', async () => {
    const { sql, attempts } = scriptedSql([{ error: connectTimeout() }, { value: [] }]);
    expect(await connectRetry(sql).unsafe('select 1').values()).toEqual([[1, 'a']]);
    expect(attempts()).toBe(2);
  });

  test('a transaction is not retried — its connection belongs to begin', async () => {
    // Drizzle transactions run on the reserved connection postgres.js passes to
    // the begin callback; this proxy must never see those statements.
    const inner = scriptedSql([{ error: connectTimeout() }, { value: ['never'] }]);
    const sql = { begin: async (run: (tx: typeof inner.sql) => Promise<unknown>) => run(inner.sql) };
    await expect(connectRetry(sql).begin(async (tx) => tx.unsafe('select 1'))).rejects.toThrow('CONNECT_TIMEOUT');
    expect(inner.attempts()).toBe(1);
  });

  test('isConnectTimeoutError reads the postgres.js connection-phase code', () => {
    expect(isConnectTimeoutError(connectTimeout())).toBe(true);
    expect(isConnectTimeoutError(new Error('syntax error'))).toBe(false);
    expect(isConnectTimeoutError(null)).toBe(false);
    expect(isConnectTimeoutError(Object.assign(new Error('x'), { code: 'CONNECTION_DESTROYED' }))).toBe(false);
  });
});

// ─── preparedSql ────────────────────────────────────────────────────────────
// Drizzle sends every statement as `client.unsafe(query, params)`, and
// postgres.js `unsafe()` defaults to `prepare: false`: the pool's own `prepare`
// option never reaches a Drizzle statement. `preparedSql` passes it per call.

import { preparedSql } from './client';

describe('preparedSql', () => {
  const recordingSql = () => {
    const calls: Array<{ statement: string; params: unknown; options: unknown }> = [];
    const sql = {
      unsafe: (statement: string, params?: unknown, options?: unknown) => {
        calls.push({ statement, params, options });
        return Promise.resolve([]);
      },
      begin: async (run: (tx: unknown) => Promise<unknown>) => run(sql),
      savepoint: async (run: (tx: unknown) => Promise<unknown>) => run(sql),
      end: async () => 'ended',
    };
    return { sql, calls };
  };

  test('every statement asks for a prepared statement, with its parameters intact', async () => {
    const { sql, calls } = recordingSql();
    await preparedSql(sql).unsafe('select 1 where a = $1', ['x']);
    expect(calls).toEqual([{ statement: 'select 1 where a = $1', params: ['x'], options: { prepare: true } }]);
  });

  test('a caller that passes its own options keeps them', async () => {
    const { sql, calls } = recordingSql();
    await preparedSql(sql).unsafe('select 1', [], { prepare: false });
    expect(calls[0]?.options).toEqual({ prepare: false });
  });

  test('statements inside a transaction and a savepoint are prepared too', async () => {
    const { sql, calls } = recordingSql();
    await preparedSql(sql).begin(async (tx) => {
      await (tx as typeof sql).unsafe('update t set a = $1', [1]);
      await (tx as typeof sql).savepoint(async (inner) => (inner as typeof sql).unsafe('select 2', []));
    });
    expect(calls.map((call) => call.options)).toEqual([{ prepare: true }, { prepare: true }]);
  });

  test('everything else passes through', async () => {
    const { sql } = recordingSql();
    expect(await preparedSql(sql).end()).toBe('ended');
  });
});

// ─── createDb against a connection that never completes ────────────────────
// The real regression: a TCP listener that accepts and then never speaks.
// postgres.js sends the startup packet, waits `connect_timeout`, and rejects
// the query with `write CONNECT_TIMEOUT`. Without connectRetry the client
// makes exactly one connection attempt; with it, exactly two — and the
// rejection still reaches the caller as the driver's own error.

describe('createDb connectRetry wiring', () => {
  test('a statement whose connect timed out is attempted twice on fresh connections', async () => {
    const { createServer } = await import('node:net');
    const sockets: Array<{ destroy: () => void }> = [];
    let accepts = 0;
    const server = createServer((socket) => {
      accepts += 1;
      sockets.push(socket); // accept, then never respond — the connect hangs
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const db = createDb(`postgres://kortix:kortix@127.0.0.1:${port}/kortix`, {
      connect_timeout: 0.5,
      max: 1,
    });
    try {
      let caught: unknown;
      try {
        await db.execute(sql`select 1`);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(String((caught as { cause?: { code?: string } }).cause?.code)).toBe('CONNECT_TIMEOUT');
      expect(accepts).toBe(2);
    } finally {
      await (db.$client as unknown as { end: (options?: { timeout?: number }) => Promise<void> }).end({ timeout: 1 });
      for (const socket of sockets.splice(0)) socket.destroy();
      server.close();
    }
  });

  test('the retry holds when the statement hook is armed (the API pool always arms one)', async () => {
    const { createServer } = await import('node:net');
    const sockets: Array<{ destroy: () => void }> = [];
    let accepts = 0;
    const server = createServer((socket) => {
      accepts += 1;
      sockets.push(socket);
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const rec = recorder();
    const db = createDb(
      `postgres://kortix:kortix@127.0.0.1:${port}/kortix`,
      { connect_timeout: 0.5, max: 1 },
      { onQuery: rec.onQuery },
    );
    try {
      let caught: unknown;
      try {
        await db.execute(sql`select 1`);
      } catch (error) {
        caught = error;
      }
      expect(String((caught as { cause?: { code?: string } }).cause?.code)).toBe('CONNECT_TIMEOUT');
      expect(accepts).toBe(2); // both attempts dispatch through the observed layer
      expect(rec.open()).toBe(0); // every dispatched operation settled
    } finally {
      await (db.$client as unknown as { end: (options?: { timeout?: number }) => Promise<void> }).end({ timeout: 1 });
      for (const socket of sockets.splice(0)) socket.destroy();
      server.close();
    }
  });
});
