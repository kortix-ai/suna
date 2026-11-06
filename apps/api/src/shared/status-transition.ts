/**
 * The one primitive for a lifecycle status write: a compare-and-set.
 *
 * A status write that reads the row, checks its status in code, and then
 * writes `WHERE id = ?` loses every race in the gap between the two
 * statements: a concurrent writer moves the row, and the blind write puts it
 * where the later writer says, over a terminal state (a merged change request
 * read `closed`, a cancelled deletion read `completed`, a deleted runtime read
 * `running`).
 *
 * `transitionStatus` makes the status check part of the UPDATE:
 *
 *   UPDATE <table> SET status = <to>, ... WHERE <row> AND status IN (<from>) [AND <guard>]
 *   RETURNING *
 *
 * PostgreSQL re-evaluates the WHERE on the newest row version after a blocked
 * UPDATE gets the lock, so a writer that lost the race matches zero rows. The
 * result says so: `{ applied: false }` is a lost race (or a row that was never
 * in a `from` state), and the caller decides what that means, never a write.
 *
 * The owning module of a table names its transitions once, as
 * `{ from, to }` rules (`session-lifecycle/status-transitions.ts` is the model
 * for sessions and sandboxes). `kortix-api/guarded-status` in
 * eslint.config.mjs refuses a `.set({ status })` on a guarded table anywhere
 * else.
 */

import type { Database } from '@kortix/db';
import { type SQL, and, inArray } from 'drizzle-orm';
import type { PgColumn, PgTable, PgUpdateSetSource } from 'drizzle-orm/pg-core';

import { db } from './db';

/** One named transition: the statuses it may leave and the status it writes. */
export interface StatusRule<S extends string = string> {
  readonly from: readonly S[];
  readonly to: S;
}

/** A database handle or an open transaction. */
export type StatusExecutor = Pick<Database, 'update'>;

/** The moved row, or a lost race. */
export type TransitionResult<Row> = { applied: true; row: Row } | { applied: false };

/**
 * Apply `rule` to the row(s) `where` selects. Writes `status = rule.to` plus
 * `set`, only where the status is one of `rule.from` and `guard` holds.
 * Returns the first moved row.
 */
export async function transitionStatus<TTable extends PgTable>(
  table: TTable,
  status: PgColumn,
  rule: StatusRule,
  write: { where: SQL | undefined; set?: PgUpdateSetSource<TTable>; guard?: SQL },
  exec: StatusExecutor = db,
): Promise<TransitionResult<TTable['$inferSelect']>> {
  const rows = await transitionStatusAll(table, status, rule, write, exec);
  return rows.length > 0 ? { applied: true, row: rows[0] } : { applied: false };
}

/** `transitionStatus` for a set of rows: every row that moved. */
export async function transitionStatusAll<TTable extends PgTable>(
  table: TTable,
  status: PgColumn,
  rule: StatusRule,
  write: { where: SQL | undefined; set?: PgUpdateSetSource<TTable>; guard?: SQL },
  exec: StatusExecutor = db,
): Promise<TTable['$inferSelect'][]> {
  if (rule.from.length === 0) return [];
  const set = { ...(write.set ?? {}), [columnKey(table, status)]: rule.to } as PgUpdateSetSource<TTable>;
  // The drizzle builder is generic over a concrete table; this module is
  // generic over every table, so the chain is typed at its two ends.
  const rows = (await (exec.update(table as never) as any)
    .set(set)
    .where(and(write.where, inArray(status, rule.from as string[]), write.guard))
    .returning()) as TTable['$inferSelect'][];
  return rows;
}

/** The drizzle property name of `column` on `table` (`status`, `state`, ...). */
function columnKey(table: PgTable, column: PgColumn): string {
  for (const [key, value] of Object.entries(table)) {
    if (value === column) return key;
  }
  throw new Error(`transitionStatus: column ${column.name} is not on the table`);
}
