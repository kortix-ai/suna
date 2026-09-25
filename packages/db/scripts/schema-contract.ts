#!/usr/bin/env bun
/**
 * Schema CONTRACT gate: `src/schema/kortix.ts` must describe the database that
 * the committed migrations build.
 *
 *   DATABASE_URL=<freshly migrated db> bun scripts/schema-contract.ts
 *
 * Exit 0 = every relation, column, index and unique constraint that kortix.ts
 *          declares exists in the `kortix` schema with the declared kind, and
 *          every object in that schema is declared or on the SQL-only list.
 * Exit 1 = drift. Each line names the object and the fix.
 *
 * Why it exists: kortix.ts, the drizzle-kit snapshot and the database were
 * kept in agreement by hand, and nothing noticed when they disagreed. Eight
 * compatibility views were declared as tables, and indexes were declared that
 * no migration ever built. One of them was the unique index that compute
 * metering relies on for de-duplication (built later by
 * 20260924221824400_sandbox_compute_sessions_one_open_index).
 *
 * `schema-sync` (drizzle-kit generate against the snapshot) and
 * `verify-live-schema.ts` (migrations against a live database) do not catch
 * that class: neither compares kortix.ts with a real catalog. This does, in the
 * `shadow-db` job of db-migrations.yml, right after every migration is applied
 * to an empty PostgreSQL.
 */
import { is } from 'drizzle-orm';
import { PgTable, PgView, getTableConfig, getViewConfig } from 'drizzle-orm/pg-core';
import { type Catalog, connectReadOnly, readCatalog } from './catalog';
import { SQL_ONLY, type SqlOnlyList } from './schema-contract-sql-only';

const SCHEMA = 'kortix';

export interface IndexContract {
  relation: string;
  unique: boolean;
}

export interface SchemaContract {
  /** relation name -> kind */
  relations: Map<string, 'table' | 'view'>;
  /** `relation.column` */
  columns: Set<string>;
  /** index name -> relation and uniqueness. Excludes indexes that back a constraint. */
  indexes: Map<string, IndexContract>;
  /** unique constraint name -> relation */
  uniqueConstraints: Map<string, string>;
}

/** What a Drizzle schema module declares for the `kortix` schema. */
export function declaredContract(schemaModule: Record<string, unknown>): SchemaContract {
  const contract: SchemaContract = {
    relations: new Map(),
    columns: new Set(),
    indexes: new Map(),
    uniqueConstraints: new Map(),
  };
  for (const value of Object.values(schemaModule)) {
    if (is(value, PgTable)) {
      const config = getTableConfig(value);
      if ((config.schema ?? 'public') !== SCHEMA) continue;
      contract.relations.set(config.name, 'table');
      for (const column of config.columns) {
        contract.columns.add(`${config.name}.${column.name}`);
        if (column.isUnique && column.uniqueName) contract.uniqueConstraints.set(column.uniqueName, config.name);
      }
      for (const index of config.indexes) {
        if (!index.config.name) throw new Error(`kortix.ts: an index on ${config.name} has no explicit name`);
        contract.indexes.set(index.config.name, { relation: config.name, unique: index.config.unique });
      }
      for (const unique of config.uniqueConstraints) contract.uniqueConstraints.set(unique.getName(), config.name);
    } else if (is(value, PgView)) {
      const config = getViewConfig(value);
      if ((config.schema ?? 'public') !== SCHEMA) continue;
      contract.relations.set(config.name, 'view');
      for (const field of Object.values(config.selectedFields)) {
        const name = (field as { name?: unknown }).name;
        if (typeof name === 'string') contract.columns.add(`${config.name}.${name}`);
      }
    }
  }
  return contract;
}

/**
 * Pure: the `kortix.ts`-comparable part of the catalog. Indexes that implement
 * a PRIMARY KEY, UNIQUE or EXCLUDE constraint are the constraint, not an
 * index. INVALID indexes are returned separately and reported as drift.
 */
export function liveContract(catalog: Catalog): { contract: SchemaContract; invalid: string[] } {
  const contract: SchemaContract = {
    relations: new Map(catalog.relations),
    columns: new Set(catalog.columns),
    indexes: new Map(),
    uniqueConstraints: new Map(),
  };
  const invalid: string[] = [];
  for (const [name, index] of catalog.indexes) {
    if (index.backsConstraint) continue;
    contract.indexes.set(name, { relation: index.table, unique: index.unique });
    if (!index.valid) invalid.push(name);
  }
  for (const [name, constraint] of catalog.constraints) {
    if (constraint.type === 'u') contract.uniqueConstraints.set(name, constraint.table);
  }
  return { contract, invalid };
}

/** Pure: every disagreement between kortix.ts and the catalog, one line each, sorted. */
export function diffContract(
  declared: SchemaContract,
  live: SchemaContract,
  sqlOnly: SqlOnlyList = SQL_ONLY,
  invalidIndexes: string[] = [],
): string[] {
  const drift: string[] = [];
  const add = (line: string) => drift.push(line);

  // ── kortix.ts -> database ─────────────────────────────────────────────────
  for (const [name, kind] of declared.relations) {
    const liveKind = live.relations.get(name);
    if (!liveKind) add(`${name}: declared as a ${kind}, but no such relation exists`);
    else if (liveKind !== kind) add(`${name}: declared as a ${kind}, but it is a ${liveKind}`);
  }
  for (const column of declared.columns) {
    const relation = column.split('.')[0]!;
    if (live.relations.has(relation) && !live.columns.has(column)) {
      add(`${column}: declared column does not exist`);
    }
  }
  for (const [name, index] of declared.indexes) {
    const liveIndex = live.indexes.get(name);
    if (!liveIndex) {
      add(`${name}: declared index on ${index.relation} was never built (create it in a .concurrent.ts migration, or delete the declaration)`);
    } else if (liveIndex.relation !== index.relation) {
      add(`${name}: declared on ${index.relation}, but it indexes ${liveIndex.relation}`);
    } else if (liveIndex.unique !== index.unique) {
      add(`${name}: declared ${index.unique ? 'unique' : 'non-unique'}, but it is ${liveIndex.unique ? 'unique' : 'non-unique'}`);
    }
  }
  for (const [name, relation] of declared.uniqueConstraints) {
    if (live.uniqueConstraints.get(name) !== relation) {
      add(`${name}: declared unique constraint on ${relation} does not exist`);
    }
  }
  for (const name of invalidIndexes) add(`${name}: index is INVALID (a failed CONCURRENTLY build)`);

  // ── database -> kortix.ts ─────────────────────────────────────────────────
  const sqlOnlyRelation = (name: string) => name in sqlOnly.tables;
  for (const [name, kind] of live.relations) {
    if (!declared.relations.has(name) && !sqlOnlyRelation(name)) {
      add(`${name}: the database has this ${kind}, but kortix.ts does not declare it`);
    }
  }
  for (const column of live.columns) {
    const relation = column.split('.')[0]!;
    if (declared.relations.has(relation) && !declared.columns.has(column) && !(column in sqlOnly.columns)) {
      add(`${column}: the database has this column, but kortix.ts does not declare it`);
    }
  }
  for (const [name, index] of live.indexes) {
    if (sqlOnlyRelation(index.relation) || declared.indexes.has(name)) continue;
    if (!(name in sqlOnly.indexes)) {
      add(`${name}: the database has this ${index.unique ? 'unique ' : ''}index on ${index.relation}, but kortix.ts does not declare it`);
    }
  }
  for (const [name, relation] of live.uniqueConstraints) {
    if (sqlOnlyRelation(relation) || declared.uniqueConstraints.has(name)) continue;
    add(`${name}: the database has this unique constraint on ${relation}, but kortix.ts does not declare it`);
  }

  // ── the SQL-only list only shrinks ────────────────────────────────────────
  for (const name of Object.keys(sqlOnly.tables)) {
    if (!live.relations.has(name)) add(`${name}: listed as SQL-only, but the relation no longer exists; delete the entry`);
    else if (declared.relations.has(name)) add(`${name}: listed as SQL-only, but kortix.ts declares it; delete the entry`);
  }
  for (const column of Object.keys(sqlOnly.columns)) {
    if (!live.columns.has(column)) add(`${column}: listed as SQL-only, but the column no longer exists; delete the entry`);
    else if (declared.columns.has(column)) add(`${column}: listed as SQL-only, but kortix.ts declares it; delete the entry`);
  }
  for (const name of Object.keys(sqlOnly.indexes)) {
    if (!live.indexes.has(name)) add(`${name}: listed as SQL-only, but the index no longer exists; delete the entry`);
    else if (declared.indexes.has(name)) add(`${name}: listed as SQL-only, but kortix.ts declares it; delete the entry`);
    else if (live.indexes.get(name)!.unique) add(`${name}: a unique index cannot be SQL-only; declare it in kortix.ts`);
  }

  return drift.sort();
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Usage: DATABASE_URL=<freshly migrated db> bun scripts/schema-contract.ts');
    process.exit(2);
  }
  const declared = declaredContract(await import('../src/schema/kortix'));
  const client = await connectReadOnly(databaseUrl);
  const catalog = await readCatalog(client, SCHEMA).finally(() => client.end());
  const { contract: live, invalid } = liveContract(catalog);
  const drift = diffContract(declared, live, SQL_ONLY, invalid);
  console.log(
    `kortix.ts: ${declared.relations.size} relations, ${declared.indexes.size} indexes, ` +
      `${declared.uniqueConstraints.size} unique constraints. Database: ${live.relations.size} relations, ` +
      `${live.indexes.size} indexes, ${live.uniqueConstraints.size} unique constraints.`,
  );
  if (drift.length === 0) {
    console.log('OK — kortix.ts describes the migrated schema.');
    return;
  }
  console.error(`::error::kortix.ts and the migrated schema disagree (${drift.length}):`);
  for (const line of drift) console.error(`  - ${line}`);
  console.error(
    '\nFix kortix.ts to describe what the migrations build, or build what kortix.ts declares with a new migration. ' +
      'A non-unique index or a legacy table that only SQL manages goes on packages/db/scripts/schema-contract-sql-only.ts, with a reason.',
  );
  process.exit(1);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}
