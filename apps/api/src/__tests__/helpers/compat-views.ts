// Test fixtures written through the RBAC compatibility views.
//
// `account_members`, `project_members`, `project_group_grants`, `iam_policies`
// and `iam_resource_grants` are views over `kortix.role_assignments`
// (20260819160100000), and `@kortix/db` declares them as views, which Drizzle
// cannot write. Their INSTEAD OF triggers still translate a write, so these
// fixtures write through them in SQL: the same rows the suites seeded when the
// names were declared as tables. When the views drop, this module is the one
// place to re-point at `account_memberships` and `role_assignments`.
import { type SQL, sql } from 'drizzle-orm';
import { type PgView, getViewConfig } from 'drizzle-orm/pg-core';

interface SqlExecutor {
  execute(query: SQL): PromiseLike<unknown>;
}

type ViewRow<V extends PgView> = Partial<V['$inferSelect']>;

function bind(value: unknown): SQL {
  // postgres-js cannot bind a JS Date inside a raw fragment; ISO text casts
  // implicitly to the view's timestamptz column.
  return sql`${value instanceof Date ? value.toISOString() : value}`;
}

/** INSERT the rows into the view. A column a row omits takes its DEFAULT. */
export async function insertIntoView<V extends PgView>(
  db: SqlExecutor,
  view: V,
  rows: ViewRow<V> | ViewRow<V>[],
): Promise<void> {
  const list = (Array.isArray(rows) ? rows : [rows]) as Record<string, unknown>[];
  if (list.length === 0) return;
  const fields = getViewConfig(view).selectedFields as Record<string, { name: string }>;
  const keys = [...new Set(list.flatMap((row) => Object.keys(row)))];
  for (const key of keys) {
    if (!fields[key]) throw new Error(`insertIntoView: ${key} is not a column of the view`);
  }
  const columns = sql.join(keys.map((key) => sql.identifier(fields[key]!.name)), sql`, `);
  const values = sql.join(
    list.map((row) => sql`(${sql.join(keys.map((key) => (key in row ? bind(row[key]) : sql`DEFAULT`)), sql`, `)})`),
    sql`, `,
  );
  await db.execute(sql`INSERT INTO ${view} (${columns}) VALUES ${values}`);
}

/** DELETE the view's rows that match `where`. */
export async function deleteFromView(db: SqlExecutor, view: PgView, where: SQL | undefined): Promise<void> {
  if (!where) throw new Error('deleteFromView: refusing to delete without a condition');
  await db.execute(sql`DELETE FROM ${view} WHERE ${where}`);
}
