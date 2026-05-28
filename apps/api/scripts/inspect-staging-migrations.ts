/**
 * Phase A — read-only snapshot of staging schema state.
 *
 * Loads STAGING_DB_URL from apps/api/.env (must be uncommented) and queries:
 *   1. supabase_migrations.schema_migrations (what supabase CLI tracked)
 *   2. drizzle.__drizzle_migrations (what drizzle thinks is applied)
 *   3. Presence of every "modern" migration's hallmark table/column so we can
 *      tell which files actually ran via ensureSchema (whose changes don't
 *      show up in supabase_migrations).
 *   4. Whether kortix_migrations.applied (our new tracking) already exists
 *
 * NEVER writes. NEVER prints the password.
 */

import { readFileSync } from 'node:fs';
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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return url.replace(/:[^:@/]+@/, ':***@');
  }
}

async function main() {
  const env = loadEnv(join(import.meta.dir, '..', '.env'));
  const url = env.STAGING_DB_URL;
  if (!url) {
    console.error('STAGING_DB_URL not found in apps/api/.env');
    process.exit(1);
  }
  console.log(`Connecting to: ${redactUrl(url)}`);

  const sql = postgres(url, { max: 1, ssl: 'prefer', connect_timeout: 10 });
  try {
    // 1. Supabase CLI's tracking
    const sbRows = (await sql`
      SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version
    `) as Array<{ version: string; name: string | null }>;

    console.log(`\n=== supabase_migrations.schema_migrations (${sbRows.length} rows) ===`);
    if (sbRows.length > 0) {
      console.log(`first: ${sbRows[0].version}  last: ${sbRows[sbRows.length - 1].version}`);
      console.log(`last 10:`);
      for (const r of sbRows.slice(-10)) console.log(`  ${r.version}  ${r.name ?? ''}`);
    }

    // 2. Drizzle's tracking (rarely used here)
    let drizzleRows: Array<{ hash: string; created_at: bigint | number | null }> = [];
    try {
      drizzleRows = (await sql`
        SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id
      `) as never;
    } catch {
    }
    console.log(`\n=== drizzle.__drizzle_migrations: ${drizzleRows.length} rows ===`);

    // 3. Our new tracking table — does it exist already?
    const hasNewTracking = (await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'kortix_migrations' AND table_name = 'applied'
      ) AS exists
    `) as Array<{ exists: boolean }>;
    console.log(`\n=== kortix_migrations.applied exists? ${hasNewTracking[0]?.exists} ===`);

    // 4. Schema probes — does each migration's hallmark exist?
    // For every recent migration (75-93), check the table/column it introduced.
    const probes: Array<{ migration: string; check: string; result?: boolean }> = [
      // pre-billing-v2
      { migration: '00000000000079_external_member_grants', check: "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='kortix' AND table_name='account_members' AND column_name='external_account_id') AS r" },
      { migration: '00000000000079_iam_v2_grant_expiry',    check: "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='kortix' AND table_name='project_group_grants' AND column_name='expires_at') AS r" },
      { migration: '00000000000080_drop_legacy_trigger_tables', check: "SELECT NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='kortix' AND table_name='triggers') AS r" },
      { migration: '00000000000080_invite_bootstrap_grants', check: "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='kortix' AND table_name='invite_grants') AS r" },
      { migration: '00000000000081_drop_stale_chat_channel_bindings_workspace_index', check: "SELECT NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='kortix' AND indexname='chat_channel_bindings_workspace_idx') AS r" },
      { migration: '00000000000082_project_session_visibility',   check: "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='kortix' AND table_name='project_sessions' AND column_name='visibility') AS r" },
      { migration: '00000000000083_project_secret_personal_overrides', check: "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='kortix' AND table_name='project_secrets' AND column_name='actor_user_id') AS r" },
      { migration: '00000000000084_iam_v2_project_group_grants', check: "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='kortix' AND table_name='project_group_grants') AS r" },
      { migration: '00000000000085_iam_v2_enabled',         check: "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='kortix' AND table_name='accounts' AND column_name='iam_v2_enabled') AS r" },
      { migration: '00000000000086_iam_v2_default_true',    check: "SELECT (column_default IS NOT NULL) AS r FROM information_schema.columns WHERE table_schema='kortix' AND table_name='accounts' AND column_name='iam_v2_enabled'" },
      { migration: '00000000000087_drop_iam_v1',            check: "SELECT NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='kortix' AND table_name='iam_policies') AS r" },
      // billing-v2 (mine)
      { migration: '00000000000088_billing_v2_per_seat_columns', check: "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='kortix' AND table_name='credit_accounts' AND column_name='billing_model') AS r" },
      { migration: '00000000000088_executor_project_policies', check: "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='kortix' AND table_name='executor_project_policies') AS r" },
      { migration: '00000000000089_sandbox_compute_sessions', check: "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='kortix' AND table_name='sandbox_compute_sessions') AS r" },
      { migration: '00000000000090_yolo_member_tokens',     check: "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='kortix' AND table_name='yolo_member_tokens') AS r" },
      { migration: '00000000000091_billing_v2_drop_subbuckets', check: "SELECT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='kortix' AND table_name='credit_accounts' AND column_name='compute_subbucket_balance') AS r" },
      { migration: '00000000000092_atomic_use_credits_ledger_type', check: "SELECT EXISTS (SELECT 1 FROM information_schema.routines WHERE routine_schema='kortix' AND routine_name='atomic_use_credits') AS r" },
      { migration: '00000000000093_auto_topup_failure_tracking', check: "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='kortix' AND table_name='credit_accounts' AND column_name='auto_topup_consecutive_failures') AS r" },
    ];

    console.log(`\n=== Schema-state probes (true = hallmark present in staging) ===`);
    for (const p of probes) {
      try {
        const r = (await sql.unsafe(p.check)) as Array<{ r: boolean | null }>;
        p.result = r[0]?.r === true;
      } catch (err) {
        p.result = undefined;
      }
      const mark = p.result === true ? '✓' : p.result === false ? '✗' : '?';
      console.log(`  ${mark}  ${p.migration}`);
    }

    // 5. Row counts on touchy tables — confirms data is intact
    console.log(`\n=== Row counts on key tables (data preservation check) ===`);
    const tables = ['accounts', 'projects', 'credit_accounts', 'credit_ledger', 'usage_events'];
    for (const t of tables) {
      try {
        const c = (await sql.unsafe(`SELECT count(*)::int AS n FROM kortix.${t}`)) as Array<{ n: number }>;
        console.log(`  kortix.${t}: ${c[0]?.n ?? '?'}`);
      } catch (err) {
        console.log(`  kortix.${t}: (table missing or unreadable)`);
      }
    }

    console.log(`\nDone — read-only inspection complete.`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('inspection failed:', err);
  process.exit(1);
});
