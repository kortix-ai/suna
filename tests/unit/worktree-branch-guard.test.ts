import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A `pnpm worktree` checkout belongs to one canonical branch (AGENTS.md). On
// 2026-09-28 one session switched another session's worktree to its own branch
// and committed there; the owner's next commit then landed on the wrong pull
// request. The pre-commit hook runs scripts/check-worktree-branch.sh and refuses
// a commit on any other branch in a marked worktree.

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'check-worktree-branch.sh');

function repo(marker?: { branch: string }, branch = 'feature'): string {
  const dir = mkdtempSync(join(tmpdir(), 'wt-guard-'));
  const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', branch);
  if (marker) writeFileSync(join(dir, '.kortix-worktree.json'), JSON.stringify({ slot: 1, branch: marker.branch }, null, 2));
  return dir;
}

function check(dir: string, env: Record<string, string> = {}) {
  return spawnSync('sh', [SCRIPT], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env, KORTIX_WORKTREE_ANY_BRANCH: env.KORTIX_WORKTREE_ANY_BRANCH ?? '' } });
}

describe('worktree branch guard', () => {
  it('allows a commit on the worktree’s own branch', () => {
    expect(check(repo({ branch: 'feature' }, 'feature')).status).toBe(0);
  });

  it('allows a sub-branch of the canonical branch', () => {
    expect(check(repo({ branch: 'feature' }, 'feature/part-2')).status).toBe(0);
  });

  it('refuses a commit on another branch and says how to recover', () => {
    const r = check(repo({ branch: 'feature' }, 'someone-else'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("belongs to branch 'feature'");
    expect(r.stderr).toContain("HEAD is 'someone-else'");
    expect(r.stderr).toContain('pnpm worktree create');
  });

  it('ignores checkouts without a marker (the primary checkout, plain git worktrees)', () => {
    expect(check(repo(undefined, 'anything')).status).toBe(0);
  });

  it('honours the explicit override', () => {
    expect(check(repo({ branch: 'feature' }, 'other'), { KORTIX_WORKTREE_ANY_BRANCH: '1' }).status).toBe(0);
  });
});
