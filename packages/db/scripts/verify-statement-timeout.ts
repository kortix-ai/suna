// Proves the new client config actually bounds queries through the real
// Supabase pooler. Run with the dev env:
//   dotenvx run -f apps/api/.env -- bun packages/db/scripts/verify-statement-timeout.ts
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

// Mirror packages/db/src/client.ts exactly.
const STATEMENT_TIMEOUT_MS = Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 25_000);
const client = postgres(url, {
  prepare: false,
  max: 2,
  idle_timeout: 30,
  connect_timeout: 10,
  connection: { statement_timeout: STATEMENT_TIMEOUT_MS },
});

async function main() {
  // 1. Is the param applied on the pooled connection?
  const shown = await client`SHOW statement_timeout`;
  console.log('[1] effective statement_timeout on connection:', shown[0].statement_timeout);

  // 2. Does a long query actually get killed (well under 30s)?
  const started = Date.now();
  try {
    await client`SELECT pg_sleep(40)`; // 40s > 25s timeout → must be killed
    console.error('[2] FAIL: pg_sleep(40) completed — timeout NOT enforced through the pooler');
    process.exitCode = 2;
  } catch (err: any) {
    const elapsed = Date.now() - started;
    const code = err?.code;
    // 57014 = query_canceled (statement_timeout)
    if (code === '57014' && elapsed < 30_000) {
      console.log(`[2] PASS: query killed after ${elapsed}ms with code 57014 (statement_timeout) — pooler honors it`);
    } else {
      console.error(`[2] UNEXPECTED: code=${code} elapsed=${elapsed}ms msg=${err?.message}`);
      process.exitCode = 3;
    }
  }
}

main()
  .catch((e) => { console.error('error:', e); process.exitCode = 1; })
  .finally(() => client.end({ timeout: 5 }));
