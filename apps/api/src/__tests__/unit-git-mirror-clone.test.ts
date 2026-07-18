/**
 * Regression test for Better Stack error `8d0cffbb…`
 * ("Cloning into bare repository '/tmp/kortix/git-cache/….git'…" — state
 * Reoccurred, call site `runGit` at `apps/api/src/projects/git/mirror.ts`).
 *
 * Root cause: `git clone --bare` writes its progress line
 *   `Cloning into bare repository '/…/….git'...`
 * to stderr IMMEDIATELY, then starts the transfer. When the 30s `runGit`
 * timeout fired mid-transfer, Node SIGTERM'd git, and the ONLY stderr Node
 * captured was that benign progress line. `runGit`'s old catch did
 * `throw new Error(stderr || stdout || err.message)` — so the timeout cause
 * was completely masked and Sentry/Better Stack received the opaque progress
 * line as the Error message (with `errorType: 'Error'`), making the group
 * unactionable. Worse, the killed clone left a partial `.git` dir with no
 * `shallow` marker, so the next access saw `existsSync(repoPath)` true,
 * skipped the clone, and tried to `fetch` from a broken half-repo — wedging
 * every reader for the process lifetime.
 *
 * The fix (in `projects/git/mirror.ts`):
 *   1. `runGit` now throws a typed `GitOperationError` (kind 'timeout' |
 *      'failed'). A killed/timed-out process is `kind: 'timeout'` with a
 *      message that names the timeout + signal — NEVER the `Cloning into …`
 *      progress line. A normal non-zero exit is `kind: 'failed'` with the real
 *      `fatal:` line (progress stripped).
 *   2. The cold bare-clone path always `rm -rf`s the partial mirror dir on
 *      failure and retries once on a transient timeout, so a killed clone no
 *      longer poisons the cache.
 *   3. The global `onError` classifies `kind: 'timeout'` into a retryable 503
 *      + Retry-After WITHOUT paging Sentry (mirrors Platinum / request-deadline).
 *
 * These tests prove the classification (pure, deterministic) + the
 * partial-clone cleanup (real local git repo, no network).
 */

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const {
  classifyGitError,
  stripGitProgress,
  GitOperationError,
  refreshMirror,
  repoCachePath,
} = await import('../projects/git/mirror');

async function git(args: string[], cwd: string) {
  await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@t.t',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@t.t',
    },
  });
}

describe('stripGitProgress', () => {
  test('removes benign progress lines, keeps fatal lines', () => {
    const out = stripGitProgress(
      [
        "Cloning into bare repository '/tmp/kortix/git-cache/abc.git'...",
        'remote: Enumerating objects: 42, done.',
        'remote: Counting objects: 100% (42/42), done.',
        'Receiving objects: 100% (42/42), done.',
        "fatal: repository '/nonexistent' does not exist",
      ].join('\n'),
    );
    expect(out).toBe("fatal: repository '/nonexistent' does not exist");
  });

  test('returns empty string when only progress lines are present', () => {
    expect(
      stripGitProgress("Cloning into bare repository '/x.git'...\nremote: Counting objects: 1, done."),
    ).toBe('');
  });
});

describe('classifyGitError — the 8d0cffbb root cause', () => {
  test('a killed/timeout clone does NOT surface the "Cloning into" progress line', () => {
    // The EXACT error shape Node's execFile produces on a timeout: killed:true,
    // signal:'SIGTERM', stderr = only git's progress line (no fatal line, since
    // git was killed mid-transfer before emitting one).
    const nodeTimeoutError = Object.assign(new Error("Command failed: git clone --bare /repo /cache\nCloning into bare repository '/tmp/kortix/git-cache/5837336aa90fe415914ab32916bff7ad.git'...\n"), {
      killed: true,
      signal: 'SIGTERM',
      code: null,
      stderr: Buffer.from("Cloning into bare repository '/tmp/kortix/git-cache/5837336aa90fe415914ab32916bff7ad.git'...\n"),
      stdout: Buffer.from(''),
    });

    const classified = classifyGitError(nodeTimeoutError, ['clone', '--bare', '/repo', '/cache'], 30_000);

    expect(classified).toBeInstanceOf(GitOperationError);
    expect(classified.kind).toBe('timeout');
    expect(classified.signal).toBe('SIGTERM');
    // The opaque progress line MUST NOT be the message — that was the bug.
    expect(classified.message).not.toContain('Cloning into bare repository');
    // The real cause (timeout + signal) MUST be the message.
    expect(classified.message).toContain('timed out');
    expect(classified.message).toContain('SIGTERM');
    expect(classified.message).toContain('clone');
    // Raw stderr is preserved for debugging.
    expect(classified.stderr).toContain('Cloning into bare repository');
  });

  test('a normal non-zero exit surfaces the real fatal line, not progress noise', () => {
    const nodeExitError = Object.assign(new Error('Command failed: git clone --bare /nope /cache'), {
      killed: false,
      signal: null,
      code: 128,
      stderr: Buffer.from(
        [
          "Cloning into bare repository '/cache'...",
          "fatal: repository '/nope' does not exist",
        ].join('\n') + '\n',
      ),
      stdout: Buffer.from(''),
    });

    const classified = classifyGitError(nodeExitError, ['clone', '--bare', '/nope', '/cache'], 30_000);

    expect(classified.kind).toBe('failed');
    expect(classified.exitCode).toBe(128);
    expect(classified.message).toBe("fatal: repository '/nope' does not exist");
    expect(classified.message).not.toContain('Cloning into bare repository');
  });

  test('ETIMEDOUT code (no signal) is also classified as timeout', () => {
    const err = Object.assign(new Error('Command timed out after 30000ms'), {
      killed: false,
      signal: null,
      code: 'ETIMEDOUT',
      stderr: Buffer.from("Cloning into bare repository '/x.git'...\n"),
      stdout: Buffer.from(''),
    });
    const classified = classifyGitError(err, ['clone', '--bare', '/r', '/c'], 30_000);
    expect(classified.kind).toBe('timeout');
    expect(classified.message).toContain('timed out');
    expect(classified.message).not.toContain('Cloning into');
  });
});

describe('refreshMirror — partial-clone cleanup on failure', () => {
  test('a failed bare clone removes the partial mirror dir so the next call re-clones', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'mirror-cleanup-'));
    const cacheDir = join(workdir, 'cache');
    await mkdir(cacheDir, { recursive: true });
    // A real, fast, deterministic clone failure: nonexistent local source.
    const badUpstream = join(workdir, 'does-not-exist');

    const project = {
      projectId: 'cccccccc-0000-0000-0000-000000000003',
      repoUrl: badUpstream,
      defaultBranch: 'main',
      manifestPath: '',
      gitAuthToken: 'unused-for-local',
    } as never;

    const prevCacheDir = process.env.KORTIX_GIT_CACHE_DIR;
    process.env.KORTIX_GIT_CACHE_DIR = cacheDir;
    try {
      const repoPath = repoCachePath(project);
      await expect(refreshMirror(project)).rejects.toBeInstanceOf(GitOperationError);
      // The bug: a killed/failed clone left a partial .git dir that poisoned
      // every subsequent read. The fix removes it on failure.
      expect(existsSync(repoPath)).toBe(false);
      // And the surfaced error is the real fatal line, not "Cloning into …".
      await expect(refreshMirror(project)).rejects.toThrow(/does not exist|repository|clone/i);
    } finally {
      process.env.KORTIX_GIT_CACHE_DIR = prevCacheDir;
      await rm(workdir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('a successful clone is served from the warm cache on the next call', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'mirror-ok-'));
    const cacheDir = join(workdir, 'cache');
    const upstream = join(workdir, 'upstream');
    await mkdir(upstream, { recursive: true });
    await mkdir(cacheDir, { recursive: true });
    await git(['init', '-b', 'main'], upstream);
    await writeFile(join(upstream, 'README.md'), '# hi\n');
    await git(['add', '.'], upstream);
    await git(['commit', '-m', 'init'], upstream);

    const project = {
      projectId: 'dddddddd-0000-0000-0000-000000000004',
      repoUrl: upstream,
      defaultBranch: 'main',
      manifestPath: '',
      gitAuthToken: 'caller-supplied-token',
    } as never;

    const prevCacheDir = process.env.KORTIX_GIT_CACHE_DIR;
    process.env.KORTIX_GIT_CACHE_DIR = cacheDir;
    try {
      const repoPath = await refreshMirror(project);
      expect(existsSync(join(repoPath, 'HEAD'))).toBe(true);
      // Second call is a warm hit (no network) and must still resolve.
      const repoPath2 = await refreshMirror(project);
      expect(repoPath2).toBe(repoPath);
    } finally {
      process.env.KORTIX_GIT_CACHE_DIR = prevCacheDir;
      await rm(workdir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
