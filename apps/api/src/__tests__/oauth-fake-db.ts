// In-memory stand-in for `db` in the OAuth provider unit tests.
//
// Drizzle predicates cannot be evaluated without Postgres, so this fake keeps
// rows per table object and lets each test decide what a `select` returns via
// a per-table handler; inserts/updates/deletes are recorded and answered by
// handlers too. Every chain step returns the same thenable, mirroring how a
// drizzle query is awaitable at any point (`await db.select().from(t)`).

type Table = object;
type Row = Record<string, unknown>;

export interface FakeDbHandlers {
  select: (table: Table, ctx: { join: Table | null; columns: unknown }) => Row[];
  insert?: (table: Table, values: Row) => Row;
  update?: (table: Table, set: Row) => Row[];
  delete?: (table: Table) => Row[];
}

export interface FakeDbLog {
  inserts: Array<{ table: Table; values: Row }>;
  updates: Array<{ table: Table; set: Row }>;
  deletes: Array<{ table: Table }>;
}

let seq = 0;
export function fakeUuid(): string {
  seq += 1;
  return `00000000-0000-4000-b000-${String(seq).padStart(12, '0')}`;
}

export function createFakeDb(handlers: FakeDbHandlers): { db: Record<string, unknown>; log: FakeDbLog } {
  const log: FakeDbLog = { inserts: [], updates: [], deletes: [] };

  function chain(op: 'select' | 'insert' | 'update' | 'delete', columns?: unknown) {
    const state: { table: Table | null; join: Table | null; values: Row | null; set: Row | null } = {
      table: null,
      join: null,
      values: null,
      set: null,
    };
    let resolved: Promise<unknown> | null = null;
    const run = () => {
      if (!resolved) {
        resolved = (async () => {
          const table = state.table!;
          if (op === 'select') return handlers.select(table, { join: state.join, columns });
          if (op === 'insert') {
            const values = state.values!;
            log.inserts.push({ table, values });
            const row = handlers.insert ? handlers.insert(table, values) : { id: fakeUuid(), createdAt: new Date(), ...values };
            return [row];
          }
          if (op === 'update') {
            log.updates.push({ table, set: state.set! });
            return handlers.update ? handlers.update(table, state.set!) : [];
          }
          log.deletes.push({ table });
          return handlers.delete ? handlers.delete(table) : [];
        })();
      }
      return resolved;
    };
    const self: Record<string, unknown> = {};
    const same = () => self;
    self.from = (t: Table) => ((state.table = t), self);
    self.innerJoin = (t: Table) => ((state.join = t), self);
    self.leftJoin = (t: Table) => ((state.join = t), self);
    self.where = same;
    self.limit = same;
    self.orderBy = same;
    self.returning = same;
    self.onConflictDoUpdate = same;
    self.onConflictDoNothing = same;
    self.values = (v: Row) => ((state.values = v), self);
    self.set = (v: Row) => ((state.set = v), self);
    self.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => run().then(ok, ko);
    self.catch = (ko: (e: unknown) => unknown) => run().catch(ko);
    return self;
  }

  // `insert(t)` / `update(t)` / `delete(t)` take the table directly.
  const db = {
    select: (columns?: unknown) => chain('select', columns),
    insert: (t: Table) => {
      const c = chain('insert');
      (c as { from: (t: Table) => unknown }).from(t);
      return c;
    },
    update: (t: Table) => {
      const c = chain('update');
      (c as { from: (t: Table) => unknown }).from(t);
      return c;
    },
    delete: (t: Table) => {
      const c = chain('delete');
      (c as { from: (t: Table) => unknown }).from(t);
      return c;
    },
  };
  return { db, log };
}
