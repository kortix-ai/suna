import type pg from 'pg';

const LEDGER_TABLE = 'kortix_migrations.pgmigrations';

export async function ledgerExists(client: pg.Client): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT to_regclass('${LEDGER_TABLE}') IS NOT NULL AS exists`,
  );
  return rows[0]?.exists ?? false;
}
