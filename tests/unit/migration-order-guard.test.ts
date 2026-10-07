import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// On 2026-10-07 a migration older than dev's newest merged, and every Deploy Dev
// stopped at migrate (checkOrder). pre-push runs scripts/check-migration-order.sh,
// which refuses a branch whose new migration sorts at or before origin/dev's newest.

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'check-migration-order.sh');
const DIR = 'packages/db/migrations';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'migration-order-'));
  const git = (...args: string[]) =>
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' });
  const add = (name: string) => {
    mkdirSync(join(dir, DIR), { recursive: true });
    writeFileSync(join(dir, DIR, name), 'select 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', name);
    return git('rev-parse', 'HEAD').stdout.trim();
  };
  git('init', '-q', '-b', 'dev');
  add('20261007073001000_newest_on_dev.sql');
  git('update-ref', 'refs/remotes/origin/dev', 'HEAD');
  git('switch', '-q', '-c', 'feature');
  const push = (sha: string, ref = 'refs/heads/feature') =>
    spawnSync('sh', [SCRIPT], { cwd: dir, encoding: 'utf8', input: `${ref} ${sha} ${ref} ${'0'.repeat(40)}\n` });
  return { add, push };
}

describe('migration-order guard', () => {
  it('allows a new migration that sorts after origin/dev', () => {
    const { add, push } = repo();
    expect(push(add('20261007134337000_new.sql')).status).toBe(0);
  });

  it('refuses a new migration that sorts before origin/dev', () => {
    const { add, push } = repo();
    const r = push(add('20261006182246238_old.sql'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${DIR}/20261006182246238_old.sql`);
  });

  it('refuses an older concurrent migration too', () => {
    const { add, push } = repo();
    expect(push(add('20261006182246238_idx.concurrent.ts')).status).toBe(1);
  });

  it('allows a branch with no new migration', () => {
    expect(repo().push('HEAD').status).toBe(0);
  });
});
