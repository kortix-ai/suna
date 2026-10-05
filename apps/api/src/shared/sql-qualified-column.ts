import { type SQL, sql } from 'drizzle-orm';
import { type PgColumn, getTableConfig } from 'drizzle-orm/pg-core';

/**
 * A column reference that ALWAYS renders `"schema"."table"."column"`.
 *
 * Use it for every OUTER-table column inside a raw `sql` subquery.
 *
 * Drizzle strips table qualifiers from column references in the selection of a
 * single-table `db.select().from(t)`. A correlated subquery written there as
 * `where inner.x = ${outer.x}` renders `where inner.x = "x"`, which Postgres
 * binds to the INNER table: the correlation silently becomes a tautology.
 * INC-2026-09-15 is that bug: `loadSandbox` handed every proxied request the
 * agent of the first `project_sessions` row, and session tokens of ~50
 * unrelated projects were re-pointed at another customer's agent.
 *
 * `sql-correlated-subquery-guard.test.ts` fails the build when a raw subquery
 * references an outer column without this helper.
 */
export function qualifiedColumn(column: PgColumn): SQL {
  const table = getTableConfig(column.table);
  const schema = table.schema ?? 'public';
  return sql`${sql.identifier(schema)}.${sql.identifier(table.name)}.${sql.identifier(column.name)}`;
}
