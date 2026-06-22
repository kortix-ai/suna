#!/usr/bin/env bun
/**
 * Live-schema PRESENCE gate.
 *
 * Asserts that a live database contains every TABLE and COLUMN the committed
 * migrations define. It is the missing half of the migration safety net: the PR
 * gates (db-migrations.yml) prove the migrations REPRODUCE the schema on a fresh
 * DB, but nothing verified that a real environment ACTUALLY MATCHES them — which
 * is exactly how a faked baseline (see migrate.ts autoBaselineIfNeeded) let
 * `project_session_public_shares` go missing on prod until a user hit a 500.
 *
 *   CANONICAL_DB_URL=<freshly-migrated db>  LIVE_DB_URL=<target>  bun scripts/verify-live-schema.ts
 *   # or: bun scripts/verify-live-schema.ts --canonical <url> --live <url>
 *
 * Exit 0 = live is a superset of canonical (no missing objects).
 * Exit 1 = live is MISSING canonical tables/columns → drift; fail the deploy.
 *
 * Deliberately PRESENCE-ONLY (canonical ⊆ live): it ignores object NAMES
 * (constraints/indexes), type/default rendering, nullability, and EXTRA objects
 * on the live DB. A legacy production database carries cosmetic differences
 * (auto- vs explicitly-named constraints, `0` vs `0.00` defaults, leftover
 * legacy tables) by the hundreds; gating on full structural equality would be
 * all false positives. Missing tables/columns are unambiguous and are the class
 * of drift that actually breaks deployed code.
 */
import pg from 'pg';

export type SchemaObjects = { tables: Set<string>; columns: Set<string> };

const SCHEMA = 'kortix';

const OBJECTS_SQL = `
  SELECT 'T'::text AS k, table_name AS a, ''::text AS b
    FROM information_schema.tables
   WHERE table_schema = $1 AND table_type = 'BASE TABLE'
  UNION ALL
  SELECT 'C'::text, table_name, column_name
    FROM information_schema.columns
   WHERE table_schema = $1
`;

export async function readSchemaObjects(databaseUrl: string): Promise<SchemaObjects> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ k: string; a: string; b: string }>(OBJECTS_SQL, [SCHEMA]);
    const tables = new Set<string>();
    const columns = new Set<string>();
    for (const r of rows) {
      if (r.k === 'T') tables.add(r.a);
      else columns.add(`${r.a}.${r.b}`);
    }
    return { tables, columns };
  } finally {
    await client.end();
  }
}

/** Pure: objects in `canonical` that are absent from `live`. */
export function diffMissing(canonical: SchemaObjects, live: SchemaObjects): {
  missingTables: string[];
  missingColumns: string[];
} {
  const missingTables = [...canonical.tables].filter((t) => !live.tables.has(t)).sort();
  // A column on a table that is itself missing is reported via the table, not twice.
  const missingColumns = [...canonical.columns]
    .filter((c) => !live.columns.has(c) && live.tables.has(c.split('.')[0]))
    .sort();
  return { missingTables, missingColumns };
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

async function main() {
  const { canonical, live } = resolveUrls(process.argv.slice(2));
  // The live read is strictly read-only.
  const liveRo = live.includes('?') ? `${live}&options=-c%20default_transaction_read_only%3Don` : live;
  const [canon, target] = await Promise.all([
    readSchemaObjects(canonical),
    readSchemaObjects(liveRo).catch(() => readSchemaObjects(live)),
  ]);

  const { missingTables, missingColumns } = diffMissing(canon, target);
  console.log(
    `Canonical: ${canon.tables.size} tables / ${canon.columns.size} columns.  ` +
      `Live: ${target.tables.size} tables / ${target.columns.size} columns.`,
  );

  if (missingTables.length === 0 && missingColumns.length === 0) {
    console.log('OK — live database contains every table and column the migrations define.');
    return;
  }

  console.error('::error::Live-schema drift — the database is MISSING objects the migrations define.');
  if (missingTables.length) {
    console.error(`\nMissing TABLES (${missingTables.length}):`);
    for (const t of missingTables) console.error(`  - ${SCHEMA}.${t}`);
  }
  if (missingColumns.length) {
    console.error(`\nMissing COLUMNS (${missingColumns.length}):`);
    for (const c of missingColumns) console.error(`  - ${SCHEMA}.${c}`);
  }
  console.error('\nReconcile by adding an idempotent migration (CREATE TABLE / ADD COLUMN IF NOT EXISTS).');
  process.exit(1);
}

// Only run when invoked directly (so the pure helpers can be unit-tested).
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
