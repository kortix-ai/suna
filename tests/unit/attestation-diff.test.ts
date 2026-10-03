import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// The real script under test. Each scenario gets its own throwaway git repo
// with a local `refs/remotes/origin/main` so no network is touched.
const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'verify-attestation.mjs');
const repos: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}
function head(cwd: string): string {
  return git(cwd, 'rev-parse', 'HEAD').trim();
}
function run(cwd: string, ...args: string[]) {
  const r = spawnSync('node', [join(cwd, 'tests', 'verify-attestation.mjs'), ...args], {
    cwd,
    encoding: 'utf8',
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
/** Fresh repo: one `main` commit, origin/main ref pinned to it, the script in tests/. */
function initRepo() {
  // realpath: macOS temp dirs are symlinks, and verify-attestation.mjs guards
  // its CLI with a realpath compare of argv[1] against import.meta.url.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'attest-diff-')));
  repos.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'tests'), { recursive: true });
  copyFileSync(SCRIPT, join(dir, 'tests', 'verify-attestation.mjs'));
  writeFileSync(join(dir, 'shared.txt'), 's\n');
  writeFileSync(join(dir, 'other.txt'), 'o\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  git(dir, 'update-ref', 'refs/remotes/origin/main', head(dir));
  return dir;
}
/** Advance origin/main by a commit that touches only `other.txt` (unrelated to any PR file). */
function moveMain(dir: string) {
  git(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'other.txt'), `o-${Date.now()}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'main moves');
  git(dir, 'update-ref', 'refs/remotes/origin/main', head(dir));
}
/** PR branch that changes only pr.txt, then writes a green attestation and commits it. */
function attestPrBranch(dir: string, lanes = ['core=pass', 'packages=pass', 'db-suites=pass']) {
  git(dir, 'checkout', '-q', '-b', 'pr');
  writeFileSync(join(dir, 'pr.txt'), 'v1\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'pr change');
  expect(run(dir, 'write', ...lanes).status).toBe(0);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'attest');
  return head(dir);
}

afterEach(() => {
  for (const dir of repos.splice(0)) {
    try {
      execFileSync('rm', ['-rf', dir]);
    } catch {}
  }
});

describe('attestation keyed to the PR diff', () => {
  it('1: an unrelated origin/main merge keeps verify green', () => {
    const dir = initRepo();
    const attested = attestPrBranch(dir);
    expect(run(dir, 'verify', '--rev', attested).status).toBe(0);

    // Merge an origin/main change that touches only other.txt (not a PR file).
    moveMain(dir);
    git(dir, 'checkout', '-q', 'pr');
    git(dir, 'merge', '--no-edit', '-q', 'main');
    const merged = head(dir);

    // The PR's own file (pr.txt) is unchanged, so the attestation stays valid.
    const r = run(dir, 'verify', '--rev', merged);
    expect(r.status).toBe(0);
  });

  it('2: editing a file the PR changed after attesting goes stale (red)', () => {
    const dir = initRepo();
    attestPrBranch(dir);
    writeFileSync(join(dir, 'pr.txt'), 'v2\n'); // edit a PR file after the test run
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'late edit to a tested file');
    const r = run(dir, 'verify', '--rev', head(dir));
    expect(r.status).toBe(1);
  });

  it('3: lane gates — skipped-no-db passes, a failed lane and --strict do not', () => {
    const skip = initRepo();
    attestPrBranch(skip, ['core=pass', 'packages=pass', 'db-suites=skipped-no-db']);
    expect(run(skip, 'verify', '--rev', head(skip)).status).toBe(0);
    expect(run(skip, 'verify', '--rev', head(skip), '--strict').status).toBe(3);

    const red = initRepo();
    attestPrBranch(red, ['core=pass', 'packages=fail', 'db-suites=pass']);
    expect(run(red, 'verify', '--rev', head(red)).status).toBe(1);
  });
});
