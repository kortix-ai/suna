/**
 * The account and project rows: the ONE module that holds the `accounts` and
 * `projects` tables (lint rule `kortix-api/workspace-store-only`).
 *
 * - Reads compose the read-only handles `projectsView` and `accountsView`.
 *   At runtime each IS the table object, so every read renders the same SQL
 *   as before (`"kortix"."projects"."project_id"`, `qualifiedColumn` works).
 *   The compiler sees a view: `db.update(projectsView)` does not compile.
 * - Every write is a function here: `updateProjectRows`, `insertProjectRow`,
 *   `deleteProjectRows`, `moveProjectRowAccount`, the account equivalents,
 *   and the atomic `projects.metadata` merge expressions.
 *
 * Release 2 (design.md §4) makes `kortix.workspaces` the source of truth and
 * turns `accounts` / `projects` into compatibility views. Reads through these
 * handles keep working against a view unchanged; the writes below are the
 * only statements that move to the workspace table.
 *
 * This file is the shared layer of the API lint (it imports only drizzle,
 * `@kortix/db` and `shared/db`), so `shared/` modules can read rows too.
 */
import { accounts, projects, type Database } from '@kortix/db';
import { sql, type ColumnsSelection, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource, PgViewWithSelection } from 'drizzle-orm/pg-core';

import { db } from '../shared/db';

/** A table seen as a read-only view: its columns, no insert/update/delete. */
type ReadHandle<TName extends string, TColumns extends ColumnsSelection> = PgViewWithSelection<TName, true, TColumns>;

/** Read-only handle on `kortix.projects`. */
export const projectsView = projects as unknown as ReadHandle<'projects', typeof projects._.columns>;
/** Read-only handle on `kortix.accounts`. */
export const accountsView = accounts as unknown as ReadHandle<'accounts', typeof accounts._.columns>;

/**
 * Every `projectsView` column, for a nested selection
 * (`select({ project: projectFields })`). At runtime the table, which a
 * selection expands into its columns.
 */
export const projectFields = projects as unknown as typeof projects._.columns;

export type ProjectRow = typeof projects.$inferSelect;
export type ProjectRowInsert = typeof projects.$inferInsert;
/**
 * A project write. `metadata` is always a SQL expression (FIX-J, no
 * read-modify-write of the whole object): a merge helper below, or
 * `metadataReplace` under the row's `FOR UPDATE` lock.
 */
export type ProjectRowSet = Omit<PgUpdateSetSource<typeof projects>, 'metadata'> & { metadata?: SQL };
export type AccountRow = typeof accounts.$inferSelect;
export type AccountRowInsert = typeof accounts.$inferInsert;
export type AccountRowSet = PgUpdateSetSource<typeof accounts>;

/** `db`, or a transaction. */
export type RowsExecutor = Pick<Database, 'insert' | 'update' | 'delete'>;

/**
 * A write's row predicate. `and(...)` types as `SQL | undefined`; an
 * undefined predicate would write every row, so it throws instead.
 */
type RowsWhere = SQL | undefined;
function named(where: RowsWhere): SQL {
  if (!where) throw new Error('A project or account write must name its rows');
  return where;
}

// ─── projects ───────────────────────────────────────────────────────────────

/** `UPDATE kortix.projects SET … WHERE <where>`. `where` reads `projectsView` columns. */
export async function updateProjectRows(where: RowsWhere, set: ProjectRowSet, executor: RowsExecutor = db): Promise<void> {
  await executor.update(projects).set(set).where(named(where));
}

/** {@link updateProjectRows}, returning every updated row. */
export async function updateProjectRowsReturning(
  where: RowsWhere,
  set: ProjectRowSet,
  executor: RowsExecutor = db,
): Promise<ProjectRow[]> {
  return executor.update(projects).set(set).where(named(where)).returning();
}

/** Insert one project row and return it. */
export async function insertProjectRow(values: ProjectRowInsert, executor: RowsExecutor = db): Promise<ProjectRow> {
  const [row] = await executor.insert(projects).values(values).returning();
  return row!;
}

/**
 * Re-point one project row from `fromAccountId` to `toAccountId` (the
 * transfer and the split, `projects/lib/project-transfer.ts`). Returns the
 * updated row count: 0 when the row is no longer in `fromAccountId`.
 */
export async function moveProjectRowAccount(
  input: { projectId: string; fromAccountId: string; toAccountId: string },
  executor: Pick<Database, 'execute'> = db,
): Promise<number> {
  const rows = await executor.execute(
    sql`UPDATE ${projects} SET account_id = ${input.toAccountId}
         WHERE project_id = ${input.projectId} AND account_id = ${input.fromAccountId}`,
  );
  return Number((rows as { count?: number }).count ?? 0);
}

/** `DELETE FROM kortix.projects WHERE <where>`. Only a create that rolls itself back deletes a project row. */
export async function deleteProjectRows(where: RowsWhere, executor: RowsExecutor = db): Promise<void> {
  await executor.delete(projects).where(named(where));
}

// ─── accounts ───────────────────────────────────────────────────────────────

/** `UPDATE kortix.accounts SET … WHERE <where>`. `where` reads `accountsView` columns. */
export async function updateAccountRows(where: RowsWhere, set: AccountRowSet, executor: RowsExecutor = db): Promise<void> {
  await executor.update(accounts).set(set).where(named(where));
}

/** {@link updateAccountRows}, returning every updated row. */
export async function updateAccountRowsReturning(
  where: RowsWhere,
  set: AccountRowSet,
  executor: RowsExecutor = db,
): Promise<AccountRow[]> {
  return executor.update(accounts).set(set).where(named(where)).returning();
}

/** Insert one account row and return it. */
export async function insertAccountRow(values: AccountRowInsert, executor: RowsExecutor = db): Promise<AccountRow> {
  const [row] = await executor.insert(accounts).values(values).returning();
  return row!;
}

/** `DELETE FROM kortix.accounts WHERE <where>`: the FK cascade takes every account-keyed row. */
export async function deleteAccountRows(where: RowsWhere, executor: RowsExecutor = db): Promise<void> {
  await executor.delete(accounts).where(named(where));
}

// ─── projects.metadata: atomic merge expressions ────────────────────────────
//
// SQL-side ATOMIC merge helpers for `projects.metadata` (FIX-J).
//
// The provider-routing pin lives in `projects.metadata` (`default_sandbox_provider`
// + `active_sandbox_external_template_id`, see provider-transition-routing.ts). The
// pin's OWN writers are fenced (FOR UPDATE + generation/lease-epoch CAS), but
// EVERY other `projects.metadata` writer used to read the whole jsonb object into
// JS, mutate it, and `UPDATE ... SET metadata = <whole object>`. With no lock a
// concurrent writer holding a STALE snapshot silently reverted the pin (a
// classic read-modify-write lost update). These helpers move the mutation to the
// SQL statement so the merge reads the CURRENT row value under the write's own
// row lock — a concurrent pin write can no longer be clobbered.
//
// Every helper returns a Drizzle `SQL` fragment for the `metadata` COLUMN VALUE,
// dropped straight into a writer's own `set` (`updateProjectRows(where, { metadata: <expr>, … })`).
//
// `||` is a SHALLOW top-level merge, so a writer that owns a NESTED object
// (`experimental`, `meet`) must NOT patch it via a top-level `||` of the whole
// sub-object — two concurrent writers into the same nested key would lose an
// update one level down. `metadataMergeSubtree` / `metadataClearSubtreeKey`
// re-read + merge the CURRENT nested value in-SQL so nested writes are atomic too.
// The top-level namespaces of every writer are DISJOINT (audited: default_agent,
// triggers_paused, onboarding_completed_at, experimental, meet, default_sandbox_slug,
// icon, icon_glyph, default_reasoning_effort vs. the pin's default_sandbox_provider /
// active_sandbox_external_template_id / active_sandbox_snapshot_name /
// sandbox_provider_transition), so a shallow merge already protects the pin; the
// nested helpers protect each nested key against self-concurrency.

/** `coalesce(metadata,'{}'::jsonb)` — a NULL metadata column merges as empty. */
function metadataBase(): SQL {
  return sql`coalesce(${projects.metadata}, '{}'::jsonb)`;
}

/**
 * Top-level atomic merge: `(metadata - k1 - k2 …) || patch`. `deleteKeys` removes
 * top-level keys (chained `-` so no array binding is needed); `patch` shallow-
 * merges the remaining keys. Both are optional; an empty patch (`|| '{}'`) and an
 * empty deleteKeys list are both no-ops, so a caller can pass just one.
 */
export function metadataMerge(patch: Record<string, unknown> = {}, deleteKeys: string[] = []): SQL {
  let expr = metadataBase();
  for (const key of deleteKeys) expr = sql`(${expr} - ${key})`;
  return sql`${expr} || ${JSON.stringify(patch)}::jsonb`;
}

/**
 * Atomic NESTED merge into a single top-level object key (`experimental`, `meet`):
 * `metadata || jsonb_build_object(topKey, coalesce(metadata->topKey,'{}') || subPatch)`.
 * Re-reads the CURRENT sub-object in-SQL and merges `subPatch` into it, so two
 * concurrent writers into DIFFERENT sub-keys of the same top-level object don't
 * lose each other's update. Creates `topKey` when absent; preserves every sibling
 * top-level key (the pin included).
 */
export function metadataMergeSubtree(topKey: string, subPatch: Record<string, unknown>): SQL {
  return sql`${metadataBase()} || jsonb_build_object(${topKey}::text, coalesce(${projects.metadata} -> ${topKey}, '{}'::jsonb) || ${JSON.stringify(subPatch)}::jsonb)`;
}

/**
 * Atomic clear of ONE sub-key from a nested object, dropping the whole top-level
 * object when it becomes empty (mirrors the JS helpers' "remove `experimental`
 * when the last override is cleared" behavior). Re-reads the CURRENT sub-object
 * in-SQL, so it never reverts a concurrent write to a DIFFERENT sub-key.
 */
export function metadataClearSubtreeKey(topKey: string, subKey: string): SQL {
  const remaining = sql`(coalesce(${projects.metadata} -> ${topKey}, '{}'::jsonb) - ${subKey})`;
  return sql`CASE WHEN ${remaining} = '{}'::jsonb THEN ${metadataBase()} - ${topKey} ELSE ${metadataBase()} || jsonb_build_object(${topKey}::text, ${remaining}) END`;
}

/**
 * The whole `metadata` object. Only for a writer that read the row
 * `FOR UPDATE` in the same transaction (repository replacement), so no
 * concurrent write can land between its read and this write.
 */
export function metadataReplace(value: Record<string, unknown>): SQL {
  return sql`${JSON.stringify(value)}::jsonb`;
}
