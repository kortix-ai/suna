#!/usr/bin/env bun
/**
 * Mint a fresh CLI PAT for the first user/account in the DB and print it
 * to stdout. Used by the shell-level CLI smoke test to feed a token into
 * `kortix login --token <...>`.
 */
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import {
  generateAccountTokenPair,
  hashSecretKey,
} from '../shared/crypto';

interface Row extends Record<string, unknown> {
  user_id: string;
  account_id: string;
}

async function main() {
  const result = await db.execute<Row>(
    sql`select user_id, account_id from kortix.account_members order by joined_at limit 1`,
  );
  const rows =
    (result as unknown as { rows?: Row[] }).rows ?? (result as unknown as Row[]);
  const row = rows[0];
  if (!row) {
    process.stderr.write('no account_members rows; seed a user first\n');
    process.exit(1);
  }

  const { publicKey, secretKey } = generateAccountTokenPair();
  const hash = hashSecretKey(secretKey);
  await db.execute(sql`
    insert into kortix.account_tokens
      (account_id, user_id, name, public_key, secret_key_hash)
    values
      (${row.account_id}, ${row.user_id}, 'cli-smoke', ${publicKey}, ${hash})
  `);

  process.stdout.write(`${secretKey}\n`);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
