import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './exec';
import type { Ports } from './ports';
import { slotDbUrl } from './supabase';

/** `db`: a database URL, or a slot's ports (its own Supabase's `postgres` database). */
export async function runMigrate(worktreePath: string, db: string | Pick<Ports, 'sbDb'>): Promise<number> {
  const url = typeof db === 'string' ? db : slotDbUrl(db);
  // Provision the Supabase-platform objects the baseline assumes. On a fresh
  // Supabase-local the roles + auth already exist (the script is non-clobbering),
  // but Basejump does NOT — Supabase doesn't ship it and the old supabase/
  // migrations that used to create it are gone. This fills that gap before
  // node-pg-migrate applies the baseline.
  const prereqs = join(worktreePath, 'packages', 'db', 'scripts', 'test-prereqs.sql');
  if (existsSync(prereqs)) {
    const pre = await run(['psql', url, '-v', 'ON_ERROR_STOP=1', '-f', prereqs]);
    if (pre !== 0) return pre;
  }
  // A local worktree can apply its branch migration before an earlier-dated
  // migration lands on main. The loopback-only command accepts that ledger
  // order while applying any newly merged migration without deleting data.
  return run(['pnpm', '--filter', '@kortix/db', 'migrate:local'], {
    cwd: worktreePath,
    env: { DATABASE_URL: url },
  });
}
