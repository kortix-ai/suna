import { afterEach, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const guard = resolve(import.meta.dir, '../../check-fake-merge.sh');
const dirs: string[] = [];
const zero = '0'.repeat(40);
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-merge-'));
  dirs.push(dir);
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  git('init', '-q', '-b', 'dev');
  git('config', 'user.name', 'Synthetic');
  git('config', 'user.email', 'agent@kortix.ai');
  const commit = (message: string) => {
    git('commit', '-q', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const root = commit('root');
  git('update-ref', 'refs/remotes/origin/dev', root);
  const run = (sha = git('rev-parse', 'HEAD'), remote = zero) => Bun.spawnSync(['sh', guard], {
    cwd: dir, stdin: Buffer.from(`refs/heads/task ${sha} refs/heads/task ${remote}\n`),
    stdout: 'pipe', stderr: 'pipe',
  });
  return { dir, git, commit, root, run };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('rejects an unpublished fake merge buried below a clean tip', () => {
  const r = fixture();
  const fake = r.commit('merge origin/dev (1234567)');
  r.commit('clean tip');
  const result = r.run();
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain(fake);
  expect(result.stderr.toString()).toContain('single-parent');
});

test('allows genuine merges, ordinary subjects, and body-only mentions', () => {
  const r = fixture();
  r.git('checkout', '-q', '-b', 'side');
  r.commit('side');
  r.git('checkout', '-q', 'dev');
  r.commit('normal\n\nmerge origin/dev');
  r.git('merge', '--no-ff', 'side', '-m', 'merge origin/dev');
  expect(r.run().exitCode).toBe(0);
});

test('does not recheck published history or deleted refs', () => {
  const r = fixture();
  const published = r.commit('merge origin/dev');
  r.git('update-ref', 'refs/remotes/origin/task', published);
  r.commit('new work');
  expect(r.run().exitCode).toBe(0);
  expect(r.run(zero).exitCode).toBe(0);
  r.git('update-ref', '-d', 'refs/remotes/origin/task');
  expect(r.run(undefined, published).exitCode).toBe(0);
});

test('the installed pre-push hook refuses the fake merge before pushing', () => {
  const r = fixture();
  const fake = r.commit('merge origin/dev');
  mkdirSync(join(r.dir, '.githooks'));
  mkdirSync(join(r.dir, 'scripts'));
  copyFileSync(resolve(import.meta.dir, '../../../.githooks/pre-push'), join(r.dir, '.githooks/pre-push'));
  copyFileSync(guard, join(r.dir, 'scripts/check-fake-merge.sh'));
  // Invoke the real hook as Git does; no network or other project guards are needed.
  const result = Bun.spawnSync(['sh', '.githooks/pre-push'], {
    cwd: r.dir, stdin: Buffer.from(`refs/heads/dev ${fake} refs/heads/dev ${zero}\n`),
    stdout: 'pipe', stderr: 'pipe',
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain(`fake-merge: ${fake}`);
});

test('checks commits newly introduced to an existing remote branch', () => {
  const r = fixture();
  r.commit('merge origin/dev');
  expect(r.run(undefined, r.root).exitCode).toBe(1);
});
