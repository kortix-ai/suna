// Black-box tests for scripts/check-blocked-terms.sh: a real temporary git
// repository, the real script, real `git` output. The term is synthetic —
// customer names never appear in a test (see AGENTS.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dirname, 'check-blocked-terms.sh');
const TERMS = 'acme, Globex';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'blocked-terms-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(dir, args, { input = '', terms = TERMS } = {}) {
  const r = spawnSync('sh', [SCRIPT, ...args], {
    cwd: dir,
    input,
    encoding: 'utf8',
    env: { ...process.env, BLOCKED_COMMIT_TERMS: terms },
  });
  return { code: r.status, stderr: r.stderr };
}

function staged(content) {
  const r = repo();
  writeFileSync(join(r.dir, 'a.txt'), content);
  r.git('add', '.');
  const result = run(r.dir, ['staged']);
  r.cleanup();
  return result;
}

test('staged: an added line with a term is refused, reported as path:line', () => {
  const r = staged('one\ntwo\nCustomer is ACME here\n');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /a\.txt:3: Customer is ACME here/);
});

test('staged: matching is whole-word and case-insensitive', () => {
  assert.equal(staged('one\ntwo\nhttps://api.acme.cloud/x\n').code, 1);
  assert.equal(staged('one\ntwo\nacme-prod\n').code, 1);
  assert.equal(staged('one\ntwo\nglobex\n').code, 1);
  assert.equal(staged('one\ntwo\nacmeist acme_x xacme\n').code, 0);
});

test('staged: deleting a line that holds a term is allowed', () => {
  const r = repo();
  writeFileSync(join(r.dir, 'a.txt'), 'one\nacme\n');
  r.git('commit', '-qam', 'seed');
  writeFileSync(join(r.dir, 'a.txt'), 'one\n');
  r.git('add', '.');
  assert.equal(run(r.dir, ['staged']).code, 0);
  r.cleanup();
});

test('message: a term in the commit message is refused; git comment lines are ignored', () => {
  const r = repo();
  const msg = join(r.dir, 'MSG');
  writeFileSync(msg, 'fix: thing\n# Acme in a git comment\n');
  assert.equal(run(r.dir, ['message', msg]).code, 0);
  writeFileSync(msg, 'fix: reported by Acme\n');
  const res = run(r.dir, ['message', msg]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /commit message: fix: reported by Acme/);
  r.cleanup();
});

test('push: new commits are checked for diff, message, and ref name', () => {
  const r = repo();
  const bare = mkdtempSync(join(tmpdir(), 'blocked-terms-remote-'));
  execFileSync('git', ['init', '-q', '--bare', bare]);
  r.git('remote', 'add', 'origin', bare);
  r.git('push', '-q', 'origin', 'main');

  const push = (ref = 'refs/heads/main') => {
    const sha = r.git('rev-parse', 'HEAD').trim();
    return run(r.dir, ['push'], { input: `refs/heads/x ${sha} ${ref} ${'0'.repeat(40)}\n` });
  };

  writeFileSync(join(r.dir, 'a.txt'), 'one\ntwo\nclean\n');
  r.git('commit', '-qam', 'clean change');
  assert.equal(push().code, 0);
  assert.equal(push('refs/heads/fix-acme-crash').code, 1);

  writeFileSync(join(r.dir, 'b.txt'), 'globex\n');
  r.git('add', '.');
  r.git('commit', '-qm', 'add b');
  const diff = push();
  assert.equal(diff.code, 1);
  assert.match(diff.stderr, /b\.txt:1: globex/);

  r.git('reset', '-q', '--hard', 'HEAD~1');
  r.git('commit', '-q', '--allow-empty', '-m', 'for Acme');
  assert.equal(push().code, 1);

  // Commits already on the remote are not re-checked.
  r.git('reset', '-q', '--hard', 'origin/main');
  assert.equal(push().code, 0);

  r.cleanup();
  rmSync(bare, { recursive: true, force: true });
});

test('no decryptable terms: warns and allows', () => {
  const r = repo();
  writeFileSync(join(r.dir, 'a.txt'), 'acme\n');
  r.git('add', '.');
  const res = run(r.dir, ['staged'], { terms: '' });
  assert.equal(res.code, 0);
  assert.match(res.stderr, /could not be decrypted; check skipped/);
  r.cleanup();
});

// Every worktree runs the PRIMARY checkout's hooks (`core.hooksPath` is an
// absolute path). A worktree cut before the guard existed has neither the
// script nor the encrypted term list, so the hooks must reach both through the
// primary checkout, and a clean commit there must still succeed.
test('old worktree: primary hooks + primary term list apply; clean commits pass', () => {
  const primary = repo();
  const oldCommit = primary.git('rev-parse', 'HEAD').trim();
  const hooks = join(primary.dir, '.githooks');
  mkdirSync(hooks);
  mkdirSync(join(primary.dir, 'scripts'));
  mkdirSync(join(primary.dir, 'apps/api'), { recursive: true });
  copyFileSync(SCRIPT, join(primary.dir, 'scripts/check-blocked-terms.sh'));
  for (const hook of ['commit-msg']) {
    copyFileSync(resolve(import.meta.dirname, '../.githooks', hook), join(hooks, hook));
    chmodSync(join(hooks, hook), 0o755);
  }
  // Plaintext here is a TEST fixture with a synthetic term; the real list is encrypted.
  writeFileSync(join(primary.dir, 'apps/api/.env'), 'BLOCKED_COMMIT_TERMS="acme"\n');
  primary.git('add', '.');
  primary.git('commit', '-qm', 'guard');
  primary.git('config', 'core.hooksPath', hooks);

  const wt = mkdtempSync(join(tmpdir(), 'blocked-terms-wt-'));
  rmSync(wt, { recursive: true });
  primary.git('worktree', 'add', '-q', '-b', 'old', wt, oldCommit);
  const env = { ...process.env };
  delete env.BLOCKED_COMMIT_TERMS;
  const commit = (message) =>
    spawnSync('git', ['commit', '-q', '--allow-empty', '-m', message], { cwd: wt, encoding: 'utf8', env });

  const clean = commit('clean change');
  assert.equal(clean.status, 0, clean.stderr);
  const blocked = commit('fix for Acme');
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.match(blocked.stderr, /commit message: fix for Acme/);

  primary.cleanup();
  rmSync(wt, { recursive: true, force: true });
});
