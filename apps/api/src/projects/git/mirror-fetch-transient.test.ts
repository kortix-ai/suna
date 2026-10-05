import { afterAll, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  classifyGitError,
  fetchMirrorWithRetry,
  isTransientGitMirrorError,
  refreshMirror,
  repoCachePath,
  retryTransientGitMirror,
} from './mirror';
import type { GitBackedProject } from './types';

// Regression for the KX-HOURLY session-create failure of 2026-09-24
// (`incident-20260924T030541Z-hbcreate`).
//
// The hourly heartbeat's `sessions new` ran the create path
//
//   loadProjectAgents(project, { forceRefresh: true, rethrowReadErrors: true })
//     -> readManifestFromRepo -> refreshMirror(project, true)
//
// against a project whose bare mirror was already WARM. `refreshMirror` then
// ran a plain `git fetch --prune origin`, which — unlike the cold clone — had
// NO retry. GitHub answered `fatal: repository '<url>' not found` (the same
// transient credential/visibility blip the 2026-09-23 clone incident hit), the
// fetch threw on the first attempt, `rethrowReadErrors` rethrew it, and the
// request answered HTTP 500.
//
// The 2026-09-23 fix added `cloneBareWithRetry` for the CLONE only, even though
// its own learning names the class "clone/fetch". This test drives the real
// `refreshMirror` warm path with a `git` shim that fails the first two fetches
// with the exact incident stderr and succeeds on the third, then asserts the
// fetch was retried. Before the fix the fetch ran ONCE and the call rejected.

const execFileAsync = promisify(execFile);

const INCIDENT_STDERR =
  "fatal: repository 'https://github.com/managed-kortix/example.git/' not found";

const realGit = (() => {
  // Resolve the real git binary before any test mutates PATH.
  const path = process.env.PATH ?? '';
  for (const dir of path.split(':')) {
    const candidate = join(dir, 'git');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('real git not found on PATH');
})();

const previousPath = process.env.PATH;
const previousCacheDir = process.env.KORTIX_GIT_CACHE_DIR;

afterAll(() => {
  process.env.PATH = previousPath;
  if (previousCacheDir === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
  else process.env.KORTIX_GIT_CACHE_DIR = previousCacheDir;
});

/** Install a `git` shim ahead of the real git that fails the first
 *  `failFirstFetches` fetch subcommands with the incident stderr and succeeds
 *  after. Returns the log + fetch-count file paths. */
function installFetchShim(root: string, failFirstFetches: number) {
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const logPath = join(root, 'git-invocations.log');
  const countPath = join(root, 'fetch-count');
  writeFileSync(logPath, '');
  writeFileSync(countPath, '0');
  const shimPath = join(binDir, 'git');
  writeFileSync(
    shimPath,
    `#!/bin/sh
case "$1" in
  fetch)
    n=$(cat "${countPath}")
    n=$((n + 1))
    printf '%s' "$n" > "${countPath}"
    printf 'fetch\\n' >> "${logPath}"
    if [ "$n" -le ${failFirstFetches} ]; then
      printf '%s\\n' "${INCIDENT_STDERR}" >&2
      exit 128
    fi
    exit 0
    ;;
  *)
    printf '%s\\n' "$1" >> "${logPath}"
    exec "${realGit}" "$@"
    ;;
esac
`,
  );
  chmodSync(shimPath, 0o755);
  process.env.PATH = `${binDir}:${previousPath}`;
  return {
    fetchCount: () => Number(readFileSync(countPath, 'utf8') || '0'),
    invocations: () => readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean),
  };
}

async function makeWarmMirror(root: string): Promise<GitBackedProject> {
  process.env.KORTIX_GIT_CACHE_DIR = root;
  const project: GitBackedProject = {
    projectId: `test-mirror-fetch-${Math.random().toString(36).slice(2)}`,
    repoUrl: 'https://github.com/managed-kortix/example.git',
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    gitAuthToken: 'test-token',
  };
  const mirrorPath = repoCachePath(project);
  mkdirSync(mirrorPath, { recursive: true });
  // A real bare repo so `remote set-url` / `config` (which are NOT shimmed to
  // fail) work; only `fetch` is intercepted.
  await execFileAsync(realGit, ['init', '--bare', mirrorPath]);
  await execFileAsync(realGit, ['remote', 'add', 'origin', project.repoUrl], { cwd: mirrorPath });
  return project;
}

describe('refreshMirror warm fetch — transient retry (isolated repro)', () => {
  test('retries the warm fetch on the incident transient failure, then succeeds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mirror-fetch-'));
    const project = await makeWarmMirror(root);
    const shim = installFetchShim(root, 2);

    await refreshMirror(project, true);

    // Before the fix this was 1 (single un-retried fetch -> reject).
    expect(shim.fetchCount()).toBe(3);
    const fetches = shim.invocations().filter((line) => line === 'fetch');
    expect(fetches).toHaveLength(3);
  });

  test('does NOT retry a permanent warm-fetch failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mirror-fetch-perm-'));
    const project = await makeWarmMirror(root);
    // Shim fails with a permanent-classified message: no retry, one attempt.
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    const countPath = join(root, 'fetch-count');
    writeFileSync(countPath, '0');
    const shimPath = join(binDir, 'git');
    writeFileSync(
      shimPath,
      `#!/bin/sh
case "$1" in
  fetch)
    n=$(cat "${countPath}")
    printf '%s' "$((n + 1))" > "${countPath}"
    printf '%s\\n' "fatal: Authentication failed for 'https://github.com/managed-kortix/example.git/'" >&2
    exit 128
    ;;
  *)
    exec "${realGit}" "$@"
    ;;
esac
`,
    );
    chmodSync(shimPath, 0o755);
    process.env.PATH = `${binDir}:${previousPath}`;

    let caught: unknown;
    try {
      await refreshMirror(project, true);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(isTransientGitMirrorError(caught)).toBe(false);
    expect(Number(readFileSync(countPath, 'utf8'))).toBe(1);
  });
});

describe('fetchMirrorWithRetry (injected deps)', () => {
  const incidentError = () =>
    classifyGitError(
      { stderr: INCIDENT_STDERR, code: 128, message: 'Command failed: git fetch' },
      ['fetch', '--prune', 'origin'],
      30_000,
    );

  test('retries a transient fetch, then resolves', async () => {
    let attempts = 0;
    const slept: number[] = [];
    await fetchMirrorWithRetry({
      run: async () => {
        attempts += 1;
        if (attempts < 3) throw incidentError();
      },
      maxAttempts: 3,
      delayMs: 7,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(attempts).toBe(3);
    expect(slept).toEqual([7, 7]);
  });

  test('does NOT retry a permanent fetch failure — one attempt, then rethrow', async () => {
    let attempts = 0;
    const permanent = classifyGitError(
      { stderr: "fatal: couldn't find remote ref refs/heads/nope", code: 128, message: 'failed' },
      ['fetch', '--prune', 'origin'],
      30_000,
    );
    await expect(
      fetchMirrorWithRetry({
        run: async () => {
          attempts += 1;
          throw permanent;
        },
        maxAttempts: 3,
        delayMs: 7,
        sleep: async () => {},
      }),
    ).rejects.toBe(permanent);
    expect(attempts).toBe(1);
  });

  test('exhausts attempts on a persistent transient fetch failure', async () => {
    let attempts = 0;
    await expect(
      fetchMirrorWithRetry({
        run: async () => {
          attempts += 1;
          throw incidentError();
        },
        maxAttempts: 3,
        delayMs: 1,
        sleep: async () => {},
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(attempts).toBe(3);
  });
});

describe('retryTransientGitMirror — cleanup is optional (fetch path)', () => {
  test('runs without a cleanup callback', async () => {
    let attempts = 0;
    await retryTransientGitMirror({
      run: async () => {
        attempts += 1;
        if (attempts < 2) {
          throw classifyGitError(
            { stderr: INCIDENT_STDERR, code: 128, message: 'failed' },
            ['fetch'],
            30_000,
          );
        }
      },
      maxAttempts: 3,
      delayMs: 1,
      sleep: async () => {},
    });
    expect(attempts).toBe(2);
  });
});
