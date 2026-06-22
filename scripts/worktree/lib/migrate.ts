import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './exec';
import type { Ports } from './ports';

export async function runMigrate(worktreePath: string, ports: Ports): Promise<number> {
  const url = `postgresql://postgres:postgres@127.0.0.1:${ports.sbDb}/postgres`;
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
  // node-pg-migrate (the same `pnpm migrate` the deploy pipeline runs) builds the
  // schema from packages/db/migrations/*.sql, tracked in kortix_migrations.pgmigrations.
  return run(['pnpm', '--filter', '@kortix/db', 'migrate'], {
    cwd: worktreePath,
    env: { DATABASE_URL: url },
  });
}
