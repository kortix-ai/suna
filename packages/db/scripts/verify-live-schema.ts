#!/usr/bin/env bun
/**
 * Live-schema gate: does a real environment contain what the migrations build?
 *
 * The PR gates (db-migrations.yml) prove the migrations REPRODUCE the schema on
 * a fresh database. Nothing else proves that a real environment MATCHES them —
 * which is how a faked baseline (see migrate.ts autoBaselineIfNeeded) left
 * `project_session_public_shares` missing on prod until a user hit a 500, and
 * left prod's `credit_ledger` with 4 of its 15 indexes (every account-scoped
 * ledger read a 2.7M-row seq scan) and `account_memberships` with no primary
 * key, found 2026-09-25.
 *
 * Compares a CANONICAL database (freshly migrated) with a LIVE one, in the
 * `kortix` schema:
 *
 *   1. TABLES, COLUMNS, ENUM VALUES — must be present on live.
 *   2. INDEXES — every index definition must exist on live, under any name
 *      (a renamed index with the same definition passes). An INVALID index on
 *      live (a failed CONCURRENTLY build) is drift.
 *   3. CONSTRAINTS — every PRIMARY KEY / UNIQUE / FOREIGN KEY / CHECK / EXCLUDE
 *      definition must exist on live, under any name. A constraint that is
 *      valid on canonical but NOT VALID on live is drift.
 *
 * All three are PRESENCE checks (canonical ⊆ live): EXTRA objects on live are
 * printed as information and never fail, because a legacy database carries
 * leftovers. Definitions are compared after removing schema qualification,
 * the object name, casts and parentheses (see definitionKey). Known, deliberate gaps are listed with their evidence in
 * verify-live-schema-waivers.ts and reported as waived.
 *
 * Run it read-only against any environment (see MIGRATIONS.md "Verify a live
 * database"):
 *
 *   CANONICAL_DB_URL=<freshly migrated db>  LIVE_DB_URL=<target>  bun scripts/verify-live-schema.ts
 *   # or: bun scripts/verify-live-schema.ts --canonical <url> --live <url>
 *
 * The live connection only runs catalog queries inside BEGIN READ ONLY.
 *
 * Exit 0 = nothing missing (waivers aside).  Exit 1 = drift.  Exit 2 = usage/connection error.
 */
import pg from 'pg';
import { LIVE_SCHEMA_WAIVERS, type LiveSchemaWaivers } from './verify-live-schema-waivers';

export type SchemaObjects = { tables: Set<string>; columns: Set<string>; enumValues: Set<string> };

export interface IndexObject {
  table: string;
  /** Definition without its name or schema qualification: `CREATE INDEX ON t USING btree (a)`. */
  definition: string;
  valid: boolean;
}

export interface ConstraintObject {
  table: string;
  /** p, u, f, c or x */
  type: string;
  /** pg_get_constraintdef without schema qualification or a trailing NOT VALID. */
  definition: string;
  validated: boolean;
}

export interface CatalogObjects extends SchemaObjects {
  /** index name -> definition. Includes the indexes that back PK/UNIQUE constraints. */
  indexes: Map<string, IndexObject>;
  /** constraint name -> definition. NOT NULL is not a pg_constraint row before PostgreSQL 18. */
  constraints: Map<string, ConstraintObject>;
  /** Applied migration names, from kortix_migrations.pgmigrations (empty if the table is absent). */
  migrations: Set<string>;
}

const SCHEMA = 'kortix';

const OBJECTS_SQL = `
  SELECT 'T'::text AS k, table_name::text AS a, ''::text AS b, ''::text AS c, ''::text AS d
    FROM information_schema.tables
   WHERE table_schema = $1 AND table_type = 'BASE TABLE'
  UNION ALL
  SELECT 'C', table_name::text, column_name::text, '', ''
    FROM information_schema.columns
   WHERE table_schema = $1
  UNION ALL
  SELECT 'E', t.typname::text, e.enumlabel::text, '', ''
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE n.nspname = $1
  UNION ALL
  SELECT 'I', i.relname::text, t.relname::text, pg_get_indexdef(x.indexrelid), x.indisvalid::text
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = $1 AND t.relkind IN ('r', 'p')
  UNION ALL
  SELECT 'K', c.conname::text, t.relname::text, c.contype::text || ':' || c.convalidated::text, pg_get_constraintdef(c.oid)
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = $1 AND c.contype IN ('p', 'u', 'f', 'c', 'x')
`;

const MIGRATIONS_SQL = `
  SELECT name FROM kortix_migrations.pgmigrations
   WHERE to_regclass('kortix_migrations.pgmigrations') IS NOT NULL
`;

/** Remove the schema qualification that renders differently per search_path. */
export function unqualify(sql: string): string {
  return sql.replace(/\b(?:kortix|public)\./g, '');
}

/** `CREATE UNIQUE INDEX foo ON kortix.t USING …` -> `CREATE UNIQUE INDEX ON t USING …`. */
export function normalizeIndexDef(def: string): string {
  return unqualify(def).replace(/^(CREATE (?:UNIQUE )?INDEX) \S+ ON (?:ONLY )?/, '$1 ON ');
}

/** Drop schema qualification and a trailing NOT VALID (validity is compared separately). */
export function normalizeConstraintDef(def: string): string {
  return unqualify(def).replace(/\s+NOT VALID$/, '');
}

const CAST =
  /::(?:"[^"]+"|character varying|timestamp with(?:out)? time zone|time with(?:out)? time zone|double precision|[a-z_][a-z0-9_]*)(?:\[\])?/g;

/**
 * Comparison key for a normalized definition. PostgreSQL versions render the
 * same expression with different casts and parentheses: PostgreSQL 15 prints
 * `((ARRAY['a'::character varying])::text[])` where 16 prints
 * `ARRAY[('a'::character varying)::text]`. Casts, parentheses and repeated
 * spaces are removed so both compare equal. Shown output keeps the full text.
 */
export function definitionKey(def: string): string {
  return def.replace(CAST, '').replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
}

type Row = { k: string; a: string; b: string; c: string; d: string };

export function catalogFromRows(rows: Row[], migrations: string[] = []): CatalogObjects {
  const out: CatalogObjects = {
    tables: new Set(),
    columns: new Set(),
    enumValues: new Set(),
    indexes: new Map(),
    constraints: new Map(),
    migrations: new Set(migrations),
  };
  for (const r of rows) {
    if (r.k === 'T') out.tables.add(r.a);
    else if (r.k === 'C') out.columns.add(`${r.a}.${r.b}`);
    else if (r.k === 'E') out.enumValues.add(`${r.a}.${r.b}`);
    else if (r.k === 'I') out.indexes.set(r.a, { table: r.b, definition: normalizeIndexDef(r.c), valid: r.d === 'true' });
    else if (r.k === 'K') {
      const [type, validated] = r.c.split(':');
      out.constraints.set(r.a, {
        table: r.b,
        type: type!,
        definition: normalizeConstraintDef(r.d),
        validated: validated === 'true',
      });
    }
  }
  return out;
}

export async function readCatalog(databaseUrl: string, { readOnly = false } = {}): Promise<CatalogObjects> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    if (readOnly) await client.query('BEGIN READ ONLY');
    const { rows } = await client.query<Row>(OBJECTS_SQL, [SCHEMA]);
    const migrations = await client.query<{ name: string }>(MIGRATIONS_SQL).then(
      (r) => r.rows.map((m) => m.name),
      () => [] as string[],
    );
    if (readOnly) await client.query('ROLLBACK');
    return catalogFromRows(rows, migrations);
  } finally {
    await client.end();
  }
}

/** Back-compat for callers of the presence-only reader. */
export async function readSchemaObjects(databaseUrl: string): Promise<SchemaObjects> {
  const { tables, columns, enumValues } = await readCatalog(databaseUrl);
  return { tables, columns, enumValues };
}

/** Pure: tables/columns/enum values in `canonical` that are absent from `live`. */
export function diffMissing(canonical: SchemaObjects, live: SchemaObjects): {
  missingTables: string[];
  missingColumns: string[];
  missingEnumValues: string[];
} {
  const missingTables = [...canonical.tables].filter((t) => !live.tables.has(t)).sort();
  // A column on a table that is itself missing is reported via the table, not twice.
  const missingColumns = [...canonical.columns]
    .filter((c) => !live.columns.has(c) && live.tables.has(c.split('.')[0]!))
    .sort();
  const missingEnumValues = [...canonical.enumValues].filter((v) => !live.enumValues.has(v)).sort();
  return { missingTables, missingColumns, missingEnumValues };
}

export interface StructureDrift {
  /** Canonical index definitions no live index has. `name: definition`. */
  missingIndexes: string[];
  /** Live indexes that are INVALID. */
  invalidIndexes: string[];
  /** Canonical constraint definitions no live constraint on that table has. */
  missingConstraints: string[];
  /** Constraints valid on canonical whose live counterpart is NOT VALID. */
  unvalidatedConstraints: string[];
  /** Missing objects covered by a waiver. `name: reason`. */
  waived: string[];
  /** Waiver entries naming an object the migrations no longer build. */
  staleWaivers: string[];
  /** Live index definitions canonical does not have (information only). */
  extraIndexes: string[];
  /** Live constraint definitions canonical does not have (information only). */
  extraConstraints: string[];
}

/**
 * Pure: compare indexes and constraints by definition, on tables that exist on
 * both sides (a missing table is reported by diffMissing, not here).
 */
export function diffStructure(
  canonical: CatalogObjects,
  live: CatalogObjects,
  waivers: LiveSchemaWaivers = LIVE_SCHEMA_WAIVERS,
): StructureDrift {
  const drift: StructureDrift = {
    missingIndexes: [],
    invalidIndexes: [],
    missingConstraints: [],
    unvalidatedConstraints: [],
    waived: [],
    staleWaivers: [],
    extraIndexes: [],
    extraConstraints: [],
  };
  const shared = (table: string) => canonical.tables.has(table) && live.tables.has(table);

  const liveIndexDefs = new Set([...live.indexes.values()].map((i) => definitionKey(i.definition)));
  const canonicalIndexDefs = new Set([...canonical.indexes.values()].map((i) => definitionKey(i.definition)));
  for (const [name, index] of canonical.indexes) {
    if (!shared(index.table) || liveIndexDefs.has(definitionKey(index.definition))) continue;
    if (name in waivers.indexes) drift.waived.push(`index ${name}: ${waivers.indexes[name]}`);
    else drift.missingIndexes.push(`${name}: ${index.definition}`);
  }
  for (const [name, index] of live.indexes) {
    if (!index.valid) drift.invalidIndexes.push(`${name} on ${index.table}`);
    if (shared(index.table) && !canonicalIndexDefs.has(definitionKey(index.definition))) {
      drift.extraIndexes.push(`${name}: ${index.definition}`);
    }
  }

  const constraintKey = (c: ConstraintObject) => `${c.table}|${c.type}|${definitionKey(c.definition)}`;
  const liveConstraints = new Map<string, ConstraintObject>();
  for (const c of live.constraints.values()) {
    const key = constraintKey(c);
    // Prefer a validated copy when two live constraints share a definition.
    if (!liveConstraints.get(key)?.validated) liveConstraints.set(key, c);
  }
  const canonicalConstraintKeys = new Set([...canonical.constraints.values()].map(constraintKey));
  for (const [name, c] of canonical.constraints) {
    if (!shared(c.table)) continue;
    const match = liveConstraints.get(constraintKey(c));
    if (!match) {
      if (name in waivers.constraints) drift.waived.push(`constraint ${name}: ${waivers.constraints[name]}`);
      else drift.missingConstraints.push(`${name} on ${c.table}: ${c.definition}`);
    } else if (c.validated && !match.validated) {
      drift.unvalidatedConstraints.push(`${name} on ${c.table}: ${c.definition}`);
    }
  }
  for (const [name, c] of live.constraints) {
    if (shared(c.table) && !canonicalConstraintKeys.has(constraintKey(c))) {
      drift.extraConstraints.push(`${name} on ${c.table}: ${c.definition}`);
    }
  }

  for (const name of Object.keys(waivers.indexes)) {
    if (!canonical.indexes.has(name)) drift.staleWaivers.push(`index ${name}`);
  }
  for (const name of Object.keys(waivers.constraints)) {
    if (!canonical.constraints.has(name)) drift.staleWaivers.push(`constraint ${name}`);
  }

  for (const list of Object.values(drift)) list.sort();
  return drift;
}

/** Pure: migrations canonical applied that live has not (their objects show as missing until then). */
export function pendingMigrations(canonical: CatalogObjects, live: CatalogObjects): string[] {
  if (live.migrations.size === 0) return [];
  return [...canonical.migrations].filter((m) => !live.migrations.has(m)).sort();
}

function resolveUrls(argv: string[]): { canonical: string; live: string } {
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const canonical = flag('--canonical') ?? process.env.CANONICAL_DB_URL;
  const live = flag('--live') ?? process.env.LIVE_DB_URL;
  if (!canonical || !live) {
    console.error(
      'Usage: CANONICAL_DB_URL=<fresh-migrated> LIVE_DB_URL=<target> bun scripts/verify-live-schema.ts\n' +
        '   or: bun scripts/verify-live-schema.ts --canonical <url> --live <url>',
    );
    process.exit(2);
  }
  return { canonical, live };
}

function section(title: string, lines: string[], sink: (line: string) => void) {
  if (lines.length === 0) return;
  sink(`\n${title} (${lines.length}):`);
  for (const line of lines) sink(`  - ${line}`);
}

async function main() {
  const { canonical, live } = resolveUrls(process.argv.slice(2));
  const [canon, target] = await Promise.all([readCatalog(canonical), readCatalog(live, { readOnly: true })]);

  const presence = diffMissing(canon, target);
  const structure = diffStructure(canon, target);
  const pending = pendingMigrations(canon, target);

  console.log(
    `Canonical: ${canon.tables.size} tables, ${canon.columns.size} columns, ${canon.enumValues.size} enum values, ` +
      `${canon.indexes.size} indexes, ${canon.constraints.size} constraints.\n` +
      `Live:      ${target.tables.size} tables, ${target.columns.size} columns, ${target.enumValues.size} enum values, ` +
      `${target.indexes.size} indexes, ${target.constraints.size} constraints.`,
  );
  section(
    'NOTE — migrations applied on canonical but not on live; objects they create are reported as missing until they run',
    pending,
    console.log,
  );
  section('Waived (verify-live-schema-waivers.ts)', structure.waived, console.log);
  section('Extra INDEXES on live (information only)', structure.extraIndexes, console.log);
  section('Extra CONSTRAINTS on live (information only)', structure.extraConstraints, console.log);

  const failures: Array<[string, string[]]> = [
    ['Missing TABLES', presence.missingTables.map((t) => `${SCHEMA}.${t}`)],
    ['Missing COLUMNS', presence.missingColumns.map((c) => `${SCHEMA}.${c}`)],
    ['Missing ENUM VALUES', presence.missingEnumValues.map((v) => `${SCHEMA}.${v}`)],
    ['Missing INDEXES (by definition)', structure.missingIndexes],
    ['INVALID INDEXES on live', structure.invalidIndexes],
    ['Missing CONSTRAINTS (by definition)', structure.missingConstraints],
    ['Constraints NOT VALID on live', structure.unvalidatedConstraints],
    ['Stale waivers (the migrations no longer build these; delete the entry)', structure.staleWaivers],
  ];
  if (failures.every(([, lines]) => lines.length === 0)) {
    console.log(
      '\nOK — live contains every table, column, enum value, index and constraint the migrations define' +
        (structure.waived.length ? ` (${structure.waived.length} waived).` : '.'),
    );
    return;
  }

  console.error('\n::error::Live-schema drift — the database is MISSING objects the migrations define.');
  for (const [title, lines] of failures) section(title, lines, console.error);
  console.error(
    '\nReconcile with an idempotent migration: CREATE TABLE / ADD COLUMN / ALTER TYPE ADD VALUE IF NOT EXISTS, ' +
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS in a .concurrent.ts file, or a guarded ADD CONSTRAINT ... NOT VALID ' +
      'followed by VALIDATE CONSTRAINT.',
  );
  process.exit(1);
}

// Only run when invoked directly (so the pure helpers can be unit-tested).
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
