// pi-durable's `SqliteDatabase` facade over a Durable Object's own SQLite.
//
// Ported from Cloudflare's `agents` 0.26.0, `src/harness/pi/session-store.ts`
// (dist/harness/pi/index.js), which is MIT licensed:
//
//   MIT License. Copyright (c) 2025 Cloudflare, Inc.
//   Permission is hereby granted, free of charge, to any person obtaining a
//   copy of this software and associated documentation files (the "Software"),
//   to deal in the Software without restriction, including without limitation
//   the rights to use, copy, modify, merge, publish, distribute, sublicense,
//   and/or sell copies of the Software, and to permit persons to whom the
//   Software is furnished to do so, subject to the following conditions: The
//   above copyright notice and this permission notice shall be included in all
//   copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED
//   "AS IS", WITHOUT WARRANTY OF ANY KIND.
//
// Copied, not imported: the rest of that module pulls in the Agents SDK's
// lifecycle, `node:async_hooks` and `cloudflare:workers`, none of which a celld
// cell needs or has.

import { SQLITE_MIGRATIONS, SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

/**
 * pi's tables carry this prefix, so they cannot collide with the cell's own
 * (`files`, `ptys`, `session_env`, `environment`, …). pi names two of its
 * tables `entries` and `tasks`; an unprefixed `tasks` is exactly the kind of
 * name a cell module adds next.
 */
export const PI_TABLE_PREFIX = "pi_";

/** Open pi-durable's storage over this object's SQLite database. */
export function openPiStorage(storage, options = {}) {
  return SqliteStorage.open(new DurableObjectSqliteDatabase(storage, options));
}

/** Every table and index pi's migrations create, in any version. */
function schemaNames() {
  const names = new Set(["durable_schema"]);
  const pattern = /\bCREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;
  for (const migration of SQLITE_MIGRATIONS) {
    for (const statement of migration.statements) {
      for (const match of statement.matchAll(pattern)) names.add(match[1]);
    }
  }
  return [...names];
}

/**
 * Rewrites pi's schema identifiers outside string literals. Identifiers match
 * on word boundaries, so a column such as `record_type` is left alone.
 */
export class Prefixer {
  #pattern;
  #prefix;
  #cache = new Map();

  constructor(prefix) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(prefix)) throw new Error(`Invalid pi table prefix ${JSON.stringify(prefix)}`);
    if (prefix.startsWith("_cf_")) throw new Error("The pi table prefix must not start with _cf_");
    this.#prefix = prefix;
    this.#pattern = new RegExp(`\\b(${schemaNames().join("|")})\\b`, "g");
  }

  rewrite(sql) {
    const cached = this.#cache.get(sql);
    if (cached !== undefined) return cached;
    const rewritten = sql
      .split(/('(?:[^']|'')*')/)
      .map((part, index) => (index % 2 === 1 ? part : part.replace(this.#pattern, (name) => `${this.#prefix}${name}`)))
      .join("");
    this.#cache.set(sql, rewritten);
    return rewritten;
  }
}

/** Durable Objects bind strings, numbers, null and ArrayBuffers. */
function binding(value) {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError(`SQLite integer ${value} is outside the safe range`);
    }
    return Number(value);
  }
  if (value instanceof Uint8Array) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  return value;
}

/** Blobs come back as ArrayBuffers; pi's contract reads Uint8Arrays. */
function row(raw) {
  for (const key of Object.keys(raw)) {
    if (raw[key] instanceof ArrayBuffer) raw[key] = new Uint8Array(raw[key]);
  }
  return raw;
}

/**
 * Orders calls on the one SQLite connection. A statement runs at once when
 * nothing is waiting; while a transaction is open, it and every call after it
 * wait, in call order, for the transaction to settle, so none runs inside it.
 * A failure does not stop the calls behind it.
 */
class OperationQueue {
  #tail = Promise.resolve();
  #pending = 0;

  /** A synchronous statement: runs now unless something is ahead of it. */
  run(statement) {
    if (this.#pending > 0) return this.#enqueue(statement);
    try {
      return Promise.resolve(statement());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** An asynchronous call that holds the queue until it settles. */
  hold(call) {
    return this.#enqueue(call);
  }

  #enqueue(call) {
    this.#pending += 1;
    const settled = this.#tail.then(call).finally(() => {
      this.#pending -= 1;
    });
    this.#tail = settled.then(() => undefined, () => undefined);
    return settled;
  }
}

/** One statement on a Durable Object's synchronous SQL API. */
class Statements {
  #sql;
  #prefixer;

  constructor(sql, prefixer) {
    this.#sql = sql;
    this.#prefixer = prefixer;
  }

  exec(sql) {
    this.#sql.exec(this.#prefixer.rewrite(sql));
  }

  run(sql, params) {
    this.#sql.exec(this.#prefixer.rewrite(sql), ...params.map(binding));
  }

  get(sql, params) {
    const first = this.#sql.exec(this.#prefixer.rewrite(sql), ...params.map(binding)).next();
    return first.done ? undefined : row(first.value);
  }

  all(sql, params) {
    return this.#sql.exec(this.#prefixer.rewrite(sql), ...params.map(binding)).toArray().map(row);
  }
}

/**
 * The handle pi's transaction callback gets. It runs statements directly: the
 * transaction holds the database's queue for as long as it is open.
 */
class DurableObjectSqliteTransaction {
  #statements;
  #active = true;

  constructor(statements) {
    this.#statements = statements;
  }

  /** Called once the transaction settles; the handle is unusable after. */
  end() {
    this.#active = false;
  }

  #assertActive() {
    if (!this.#active) throw new Error("The pi SQLite transaction is no longer active");
  }

  async exec(sql) {
    this.#assertActive();
    this.#statements.exec(sql);
  }

  async run(sql, ...params) {
    this.#assertActive();
    this.#statements.run(sql, params);
  }

  async get(sql, ...params) {
    this.#assertActive();
    return this.#statements.get(sql, params);
  }

  async all(sql, ...params) {
    this.#assertActive();
    return this.#statements.all(sql, params);
  }
}

/**
 * pi's `SqliteDatabase` over `DurableObjectStorage`.
 *
 * Durable Object SQL is synchronous, but pi's facade is asynchronous and a
 * transaction's callback awaits between statements. A statement issued outside
 * the transaction while it waits would run inside it: it would see uncommitted
 * rows and roll back with it. So every call goes through one `OperationQueue`.
 * A call on the database from inside a transaction's callback waits for that
 * transaction and never settles; the callback must use its handle.
 *
 * Transactions run in `storage.transaction()`, which rolls back when the
 * callback rejects and rejects with the same error. Verified on celld 0.6.1.
 */
export class DurableObjectSqliteDatabase {
  #storage;
  #statements;
  #queue = new OperationQueue();

  constructor(storage, options = {}) {
    this.#storage = storage;
    this.#statements = new Statements(storage.sql, new Prefixer(options.prefix ?? PI_TABLE_PREFIX));
  }

  exec(sql) {
    return this.#queue.run(() => this.#statements.exec(sql));
  }

  run(sql, ...params) {
    return this.#queue.run(() => this.#statements.run(sql, params));
  }

  get(sql, ...params) {
    return this.#queue.run(() => this.#statements.get(sql, params));
  }

  all(sql, ...params) {
    return this.#queue.run(() => this.#statements.all(sql, params));
  }

  transaction(callback) {
    return this.#queue.hold(() =>
      this.#storage.transaction(async () => {
        const transaction = new DurableObjectSqliteTransaction(this.#statements);
        try {
          return await callback(transaction);
        } finally {
          transaction.end();
        }
      }),
    );
  }

  /** The object owns the database; there is nothing to close. */
  close() {
    return this.#queue.run(() => undefined);
  }
}
