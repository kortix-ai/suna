import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
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
  // main as it is before per-PR attestations: one shared legacy file.
  writeFileSync(join(dir, 'tests', 'test-attestation.json'), '{"legacy":true}\n');
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
function attestPrBranch(
  dir: string,
  lanes = ['core=pass', 'packages=pass', 'db-suites=pass'],
  branch = 'pr',
  file = 'pr.txt',
) {
  git(dir, 'checkout', '-q', '-b', branch, 'main');
  writeFileSync(join(dir, file), 'v1\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'pr change');
  expect(run(dir, 'write', ...lanes).status).toBe(0);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'attest');
  return head(dir);
}

const GREEN = ['core=pass', 'packages=pass', 'db-suites=pass'];
/** Re-run `pnpm test`'s write on the checked-out branch and commit the result. */
function reattest(dir: string) {
  expect(run(dir, 'write', ...GREEN).status).toBe(0);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 're-attest');
  return head(dir);
}
/** Merge `branch` into main (a PR merge) and move origin/main to it. */
function mergeIntoMain(dir: string, branch: string) {
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'merge', '--no-ff', '--no-edit', '-q', branch);
  git(dir, 'update-ref', 'refs/remotes/origin/main', head(dir));
}
/** True when merging `b` into `a` is textually clean (what GitHub calls MERGEABLE). */
function mergesClean(dir: string, a: string, b: string) {
  return spawnSync('git', ['merge-tree', '--write-tree', a, b], { cwd: dir, encoding: 'utf8' }).status === 0;
}
const tracked = (dir: string, rev: string) => git(dir, 'ls-tree', '-r', '--name-only', rev).split('\n');

afterEach(() => {
  for (const dir of repos.splice(0)) {
    try {
      execFileSync('rm', ['-rf', dir]);
    } catch {}
  }
});

// Each scenario runs real git processes (~1-2 s alone); under the full `pnpm test`
// load they exceed vitest's 5 s default.
const GIT_TIMEOUT = { timeout: 60_000 };

describe('attestation keyed to the PR diff', GIT_TIMEOUT, () => {
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

  it('3: lane gates — sanctioned skips pass, a failed lane and --strict do not', () => {
    const skip = initRepo();
    attestPrBranch(skip, ['core=pass', 'packages=pass', 'db-suites=skipped-no-db']);
    expect(run(skip, 'verify', '--rev', head(skip)).status).toBe(0);
    expect(run(skip, 'verify', '--rev', head(skip), '--strict').status).toBe(3);

    const image = initRepo();
    attestPrBranch(image, ['core=pass', 'packages=skipped-sandbox-image', 'db-suites=skipped-no-db']);
    expect(run(image, 'verify', '--rev', head(image)).status).toBe(0);
    expect(run(image, 'verify', '--rev', head(image), '--strict').status).toBe(3);

    const red = initRepo();
    attestPrBranch(red, ['core=pass', 'packages=fail', 'db-suites=pass']);
    expect(run(red, 'verify', '--rev', head(red)).status).toBe(1);
  });
});

describe('one attestation file per PR', GIT_TIMEOUT, () => {
  it('a: two PRs off the same main stay mergeable after one of them merges', () => {
    const dir = initRepo();
    attestPrBranch(dir, GREEN, 'feat/a', 'a.txt');
    attestPrBranch(dir, GREEN, 'feat/b', 'b.txt');
    mergeIntoMain(dir, 'feat/a');
    expect(mergesClean(dir, 'refs/remotes/origin/main', 'feat/b')).toBe(true);
    expect(tracked(dir, 'feat/b')).toContain('tests/attestations/feat-b.json');
    expect(tracked(dir, 'feat/b')).not.toContain('tests/test-attestation.json'); // legacy pruned
  });

  it('b: an unrelated main merge into B keeps verify --rev B green', () => {
    const dir = initRepo();
    attestPrBranch(dir, GREEN, 'feat/a', 'a.txt');
    attestPrBranch(dir, GREEN, 'feat/b', 'b.txt');
    mergeIntoMain(dir, 'feat/a');
    moveMain(dir);
    git(dir, 'checkout', '-q', 'feat/b');
    git(dir, 'merge', '--no-edit', '-q', 'main');
    // Detached checkout (the merge gate's worktree): the PR's own file is found from the diff.
    git(dir, 'checkout', '-q', '--detach', 'feat/b');
    const r = run(dir, 'verify', '--rev', head(dir));
    expect(r.out).toContain('OK green');
    expect(r.status).toBe(0);
  });

  it("c: editing one of B's own files after attesting goes stale", () => {
    const dir = initRepo();
    attestPrBranch(dir, GREEN, 'feat/b', 'b.txt');
    expect(run(dir, 'verify', '--rev', head(dir), '--branch', 'feat/b').status).toBe(0);
    writeFileSync(join(dir, 'b.txt'), 'v2\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'late edit');
    const r = run(dir, 'verify', '--rev', head(dir), '--branch', 'feat/b');
    expect(r.out).toContain('stale');
    expect(r.status).toBe(1);
  });

  it("d: a write prunes other PRs' files; two branches that pruned the same file merge clean", () => {
    const dir = initRepo();
    attestPrBranch(dir, GREEN, 'feat/b', 'b.txt');
    attestPrBranch(dir, GREEN, 'feat/c', 'c.txt');
    attestPrBranch(dir, GREEN, 'feat/a', 'a.txt');
    mergeIntoMain(dir, 'feat/a');
    expect(tracked(dir, 'main')).toContain('tests/attestations/feat-a.json');
    for (const branch of ['feat/b', 'feat/c']) {
      git(dir, 'checkout', '-q', branch);
      git(dir, 'merge', '--no-edit', '-q', 'main');
      expect(existsSync(join(dir, 'tests/attestations/feat-a.json'))).toBe(true);
      const rev = reattest(dir);
      expect(tracked(dir, rev)).not.toContain('tests/attestations/feat-a.json');
      expect(run(dir, 'verify', '--rev', rev).status).toBe(0);
    }
    mergeIntoMain(dir, 'feat/b');
    expect(mergesClean(dir, 'refs/remotes/origin/main', 'feat/c')).toBe(true);
    // On main (no diverging merge-base) the full-tree hash ignores other PRs' files.
    git(dir, 'checkout', '-q', 'main');
    const onMain = reattest(dir);
    expect(tracked(dir, onMain)).toContain('tests/attestations/main.json');
    expect(run(dir, 'verify', '--rev', onMain, '--strict').status).toBe(0);
  });

  it('e: a rev with only the legacy file still verifies through the legacy path', () => {
    const dir = initRepo();
    attestPrBranch(dir, GREEN, 'old', 'old.txt');
    // Recreate a pre-change branch: its attestation lives at the legacy path.
    git(dir, 'mv', '-f', 'tests/attestations/old.json', 'tests/test-attestation.json');
    git(dir, 'commit', '-qm', 'legacy layout');
    git(dir, 'checkout', '-q', '--detach');
    expect(run(dir, 'verify', '--rev', head(dir)).status).toBe(0);
    git(dir, 'checkout', '-q', 'old');
    writeFileSync(join(dir, 'old.txt'), 'v2\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'late edit');
    expect(run(dir, 'verify', '--rev', head(dir)).status).toBe(1);
  });

  it('f: with several attestations in the diff, --branch picks its own, else the newest', () => {
    const dir = initRepo();
    attestPrBranch(dir, GREEN, 'feat/b', 'b.txt'); // older, green
    attestPrBranch(dir, ['core=pass', 'packages=fail', 'db-suites=pass'], 'feat/red', 'red.txt'); // newer, red
    git(dir, 'checkout', '-q', 'feat/b');
    git(dir, 'merge', '--no-edit', '-q', 'feat/red'); // B merges another PR branch directly, not via main
    const rev = head(dir);
    git(dir, 'checkout', '-q', '--detach');
    expect(run(dir, 'verify', '--rev', rev, '--branch', 'feat/b').status).toBe(0);
    expect(run(dir, 'verify', '--rev', rev).out).toContain('FAIL red');
  });
});
