import { PgClient } from './pg-client';

/**
 * Run `write` on a second connection inside an open transaction, start
 * `contender`, wait until a statement that mentions `waitsOn` blocks on a lock
 * (or the contender finishes without blocking), then commit `write` and return
 * what the contender returns. A mocked `db` cannot reproduce this interleaving:
 * the defect lives between two statements, in what Postgres does to a blocked
 * statement when the lock holder commits.
 */
export async function interleave<T>(
  write: (tx: PgClient) => Promise<unknown>,
  contender: () => Promise<T>,
  waitsOn: string,
): Promise<T> {
  const tx = new PgClient({ connectionString: process.env.TEST_DATABASE_URL });
  // Poll from outside `tx`: a transaction reads pg_stat_activity only once.
  const probe = new PgClient({ connectionString: process.env.TEST_DATABASE_URL });
  await Promise.all([tx.connect(), probe.connect()]);
  try {
    await tx.query('BEGIN');
    await write(tx);
    let settled = false;
    const running = contender().finally(() => {
      settled = true;
    });
    running.catch(() => {}); // Rethrown by the await below, after the commit.
    const deadline = Date.now() + 10_000;
    while (!settled) {
      const waiting = await probe.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE $1`,
        [`%${waitsOn}%`],
      );
      if (waiting.rows[0].n > 0) break;
      if (Date.now() > deadline) throw new Error(`contender never blocked on a lock (${waitsOn})`);
      await Bun.sleep(20);
    }
    await tx.query('COMMIT');
    return await running;
  } finally {
    await Promise.all([tx.end(), probe.end()]);
  }
}
