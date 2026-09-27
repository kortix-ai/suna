import { describe, test, expect } from 'bun:test';
import { createDb } from './client';

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
