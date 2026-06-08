// Simulates the incident against the real (dev) DB to prove the fix:
//   - N "stuck" queries (pg_sleep) try to pin connections
//   - many fast queries run concurrently behind them
// OLD behaviour (no statement_timeout): stuck queries pin connections for up to
// the 2-min server limit → fast queries queue far past 30s.
// NEW behaviour: statement_timeout frees stuck connections at 25s, so the queue
// drains and fast queries complete. With a short test timeout we assert the
// fast queries are NOT starved indefinitely.
//
// Run: dotenvx run -f apps/api/.env -- bun packages/db/scripts/verify-pool-concurrency.ts
import postgres from 'postgres';

const url = process.env.DATABASE_URL!;
// Use a SHORT statement_timeout for a fast, decisive test (prod uses 25s).
const STMT_MS = 4000;
const MAX = 8;
const sql = postgres(url, {
  prepare: false,
  max: MAX,
  idle_timeout: 30,
  connect_timeout: 10,
  connection: { statement_timeout: STMT_MS },
});

async function main() {
  console.log(`pool max=${MAX}, statement_timeout=${STMT_MS}ms`);

  // 1) Saturate the pool with "stuck" queries (sleep longer than the timeout).
  const stuck = Array.from({ length: MAX }, (_, i) =>
    sql`SELECT pg_sleep(60)`.then(() => ({ i, ok: true })).catch((e) => ({ i, ok: false, code: e?.code })),
  );

  // 2) Fire fast queries that must wait for the pool, then complete.
  const t0 = Date.now();
  const fast = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      sql`SELECT ${i}::int AS n`.then((r) => ({ i, n: r[0].n, ms: Date.now() - t0 })),
    ),
  );
  const maxWait = Math.max(...fast.map((f) => f.ms));
  console.log(`[fast] all ${fast.length} completed; slowest waited ${maxWait}ms`);

  // The stuck queries should have been killed by statement_timeout (~STMT_MS),
  // freeing connections so the fast queries drained shortly after.
  const stuckResults = await Promise.all(stuck);
  const killed = stuckResults.filter((s: any) => !s.ok && s.code === '57014').length;
  console.log(`[stuck] ${killed}/${MAX} killed by statement_timeout (57014)`);

  // Assertions: fast queries drained within ~2× the statement_timeout, and the
  // stuck ones were bounded (not pinning connections for the 2-min server limit).
  const pass = maxWait < STMT_MS * 3 && killed === MAX;
  console.log(pass ? 'PASS: pool drained — no indefinite starvation' : 'FAIL: queue did not drain as expected');
  if (!pass) process.exitCode = 2;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => sql.end({ timeout: 5 }));
