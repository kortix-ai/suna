/**
 * Read-only: compares staging's `kortix` schema columns vs the local DB's
 * `kortix` schema columns. The local DB is the truth that matches kortix.ts,
 * so anything appearing here as "staging has but local doesn't" is a legacy
 * column we'd drop (data loss) if we naively synced. Anything "local has but
 * staging doesn't" is a column we'd add (mostly safe).
 *
 * No writes anywhere.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

function loadEnv(path: string): Record<string, string> {
  const text = readFileSync(path, 'utf-8');
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

interface ColDef {
  table: string;
  column: string;
  type: string;
  nullable: boolean;
}

async function dumpColumns(url: string): Promise<Map<string, ColDef>> {
  const sql = postgres(url, { max: 1, ssl: 'prefer' });
  try {
    const rows = (await sql`
      SELECT table_name AS table, column_name AS column,
             data_type AS type, is_nullable = 'YES' AS nullable
      FROM information_schema.columns
      WHERE table_schema = 'kortix'
      ORDER BY table_name, ordinal_position
    `) as unknown as ColDef[];
    const map = new Map<string, ColDef>();
    for (const r of rows) map.set(`${r.table}.${r.column}`, r);
    return map;
  } finally {
    await sql.end();
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

async function main() {
  const env = loadEnv(join(import.meta.dir, '..', '.env'));
  const stagingUrl = env.STAGING_DB_URL;
  const localUrl = env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  if (!stagingUrl) {
    console.error('STAGING_DB_URL not in apps/api/.env');
    process.exit(1);
  }
  console.log('Reading staging schema...');
  const staging = await dumpColumns(stagingUrl);
  console.log('Reading local schema (truth)...');
  const local = await dumpColumns(localUrl);

  const stagingTables = new Set([...staging.values()].map((c) => c.table));
  const localTables = new Set([...local.values()].map((c) => c.table));

  const onlyStaging = [...stagingTables].filter((t) => !localTables.has(t)).sort();
  const onlyLocal = [...localTables].filter((t) => !stagingTables.has(t)).sort();
  const shared = [...stagingTables].filter((t) => localTables.has(t)).sort();

  console.log(`\n╔════════════════════════════════════════════════════════════╗`);
  console.log(`║  STAGING TABLES NOT IN LOCAL  (${pad(String(onlyStaging.length), 3)} — would be left alone) ║`);
  console.log(`║  These are legacy tables. Naively syncing would DROP them. ║`);
  console.log(`╚════════════════════════════════════════════════════════════╝`);
  for (const t of onlyStaging) console.log(`  - kortix.${t}`);

  console.log(`\n╔════════════════════════════════════════════════════════════╗`);
  console.log(`║  LOCAL TABLES NOT IN STAGING  (${pad(String(onlyLocal.length), 3)} — safe to CREATE)   ║`);
  console.log(`╚════════════════════════════════════════════════════════════╝`);
  for (const t of onlyLocal) console.log(`  + kortix.${t}`);

  console.log(`\n╔════════════════════════════════════════════════════════════╗`);
  console.log(`║  SHARED TABLES  (${pad(String(shared.length), 3)} — column-level diff below)            ║`);
  console.log(`╚════════════════════════════════════════════════════════════╝`);
  let totalAdded = 0;
  let totalDropped = 0;
  let totalTypeMismatch = 0;
  for (const t of shared) {
    const stagingCols = new Map<string, ColDef>();
    const localCols = new Map<string, ColDef>();
    for (const [, c] of staging) if (c.table === t) stagingCols.set(c.column, c);
    for (const [, c] of local) if (c.table === t) localCols.set(c.column, c);

    const onlyS = [...stagingCols.keys()].filter((k) => !localCols.has(k));
    const onlyL = [...localCols.keys()].filter((k) => !stagingCols.has(k));
    const both = [...stagingCols.keys()].filter((k) => localCols.has(k));
    const typeMismatch = both.filter((k) => stagingCols.get(k)!.type !== localCols.get(k)!.type);

    if (onlyS.length === 0 && onlyL.length === 0 && typeMismatch.length === 0) continue;
    console.log(`\n  kortix.${t}`);
    for (const c of onlyS) {
      const def = stagingCols.get(c)!;
      console.log(`    ⚠ staging-only  ${pad(c, 36)} ${def.type}  (DROP would lose data)`);
      totalDropped++;
    }
    for (const c of onlyL) {
      const def = localCols.get(c)!;
      console.log(`    + local-only    ${pad(c, 36)} ${def.type}${def.nullable ? '' : '  (NOT NULL — needs default or backfill)'}`);
      totalAdded++;
    }
    for (const c of typeMismatch) {
      const s = stagingCols.get(c)!;
      const l = localCols.get(c)!;
      console.log(`    ~ TYPE diff     ${pad(c, 36)} staging=${s.type}  local=${l.type}`);
      totalTypeMismatch++;
    }
  }

  console.log(`\n╔════════════════════════════════════════════════════════════╗`);
  console.log(`║  SUMMARY                                                   ║`);
  console.log(`╚════════════════════════════════════════════════════════════╝`);
  console.log(`  Tables staging has, local doesn't (legacy):  ${onlyStaging.length}`);
  console.log(`  Tables local has, staging doesn't (new):     ${onlyLocal.length}`);
  console.log(`  Shared tables with differences:              (count below)`);
  console.log(`    columns to ADD on staging   (mostly safe): ${totalAdded}`);
  console.log(`    columns to DROP on staging  (DATA LOSS):   ${totalDropped}`);
  console.log(`    columns with TYPE mismatch  (review each): ${totalTypeMismatch}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
