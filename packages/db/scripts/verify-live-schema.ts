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
 *      live (a failed CONCURRENTLY build) is drift. Only indexes on base
 *      tables are compared: an index on a leftover materialized view is
 *      neither drift nor counted.
 *   3. CONSTRAINTS — every PRIMARY KEY / UNIQUE / FOREIGN KEY / CHECK / EXCLUDE
 *      definition must exist on live, under any name. A constraint that is
 *      valid on canonical but NOT VALID on live is drift.
 *
 * All three are PRESENCE checks (canonical ⊆ live): EXTRA objects on live are
 * printed as information and never fail, because a legacy database carries
 * leftovers. Definitions are compared after removing schema qualification,
 * the object name, casts and parentheses (see definitionKey). Known,
 * deliberate gaps are listed with their evidence in
 * verify-live-schema-waivers.ts and reported as waived.
 *
 * Run it read-only against any environment (see MIGRATIONS.md "Verify a live
 * database"):
 *
 *   CANONICAL_DB_URL=<freshly migrated db>  LIVE_DB_URL=<target>  bun scripts/verify-live-schema.ts
 *   # or: bun scripts/verify-live-schema.ts --canonical <url> --live <url>
 *
 * Both databases are read through catalog.ts `readDatabase`: one catalog
 * query and one ledger query each, on a read-only session. The script writes
 * nothing.
 *
 * Exit 0 = nothing missing (waivers aside).  Exit 1 = drift.
 * Exit 2 = usage error, connection error, or a ledger the role cannot read.
 */
import { type Catalog, type CatalogConstraint, type CatalogIndex, readDatabase } from './catalog';
import { LIVE_SCHEMA_WAIVERS, type LiveSchemaWaivers } from './verify-live-schema-waivers';

const SCHEMA = 'kortix';

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

/** The base tables (relkind r or p): the relations whose objects the migrations guarantee. */
export function tablesOf(catalog: Catalog): Set<string> {
  return new Set([...catalog.relations].filter(([, kind]) => kind === 'table').map(([name]) => name));
}

/** The objects this gate compares, with definitions normalized once. */
export interface ComparedObjects {
  /** Base tables (relkind r or p). */
  tables: Set<string>;
  /** Indexes on those tables. `definition` is `normalizeIndexDef` of the catalog's. */
  indexes: Map<string, CatalogIndex>;
  /** Every constraint. `definition` is `normalizeConstraintDef` of the catalog's. */
  constraints: Map<string, CatalogConstraint>;
}

/**
 * Pure: the base tables of `catalog`, the indexes on them, and every
 * constraint, with each definition normalized. Indexes on materialized views
 * are left out: the migrations guarantee only table objects.
 */
export function comparedObjects(catalog: Catalog): ComparedObjects {
  const tables = tablesOf(catalog);
  const indexes = new Map<string, CatalogIndex>();
  for (const [name, index] of catalog.indexes) {
    if (tables.has(index.table)) indexes.set(name, { ...index, definition: normalizeIndexDef(index.definition) });
  }
  const constraints = new Map<string, CatalogConstraint>();
  for (const [name, c] of catalog.constraints) {
    constraints.set(name, { ...c, definition: normalizeConstraintDef(c.definition) });
  }
  return { tables, indexes, constraints };
}

/** Pure: the count line printed for one database. */
export function countsLine(catalog: Catalog): string {
  const { tables, indexes, constraints } = comparedObjects(catalog);
  return (
    `${tables.size} tables, ${catalog.columns.size} columns, ${catalog.enumValues.size} enum values, ` +
    `${indexes.size} indexes, ${constraints.size} constraints.`
  );
}

/** Pure: tables/columns/enum values in `canonical` that are absent from `live`. */
export function diffMissing(canonical: Catalog, live: Catalog): {
  missingTables: string[];
  missingColumns: string[];
  missingEnumValues: string[];
} {
  const liveTables = tablesOf(live);
  const missingTables = [...tablesOf(canonical)].filter((t) => !liveTables.has(t)).sort();
  // A column on a table that is itself missing is reported via the table, not twice.
  const missingColumns = [...canonical.columns]
    .filter((c) => !live.columns.has(c) && liveTables.has(c.split('.')[0]!))
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
  canonicalCatalog: Catalog,
  liveCatalog: Catalog,
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
  const canonical = comparedObjects(canonicalCatalog);
  const live = comparedObjects(liveCatalog);
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

  const constraintKey = (c: CatalogConstraint) => `${c.table}|${c.type}|${definitionKey(c.definition)}`;
  const liveConstraints = new Map<string, CatalogConstraint>();
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

/**
 * Pure: migrations canonical applied that live has not (their objects show as
 * missing until then). A live database without a ledger reports nothing.
 */
export function pendingMigrations(canonicalLedger: readonly string[], liveLedger: readonly string[]): string[] {
  if (liveLedger.length === 0) return [];
  const applied = new Set(liveLedger);
  return canonicalLedger.filter((m) => !applied.has(m)).sort();
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
  const [canon, target] = await Promise.all([readDatabase(canonical, SCHEMA), readDatabase(live, SCHEMA)]);

  const presence = diffMissing(canon.catalog, target.catalog);
  const structure = diffStructure(canon.catalog, target.catalog);
  const pending = pendingMigrations(canon.ledger, target.ledger);

  console.log(`Canonical: ${countsLine(canon.catalog)}\nLive:      ${countsLine(target.catalog)}`);
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
