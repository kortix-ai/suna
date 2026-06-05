// Shared core for the git-backed-project operations module.
//
// Owns the module-level mirror cache + the private clone/mirror/exec internals
// + the path-normalization helper. Every other git/* module imports from here
// (and from ./types). Keep all shared mutable state in THIS module so there is
// a single mirror cache across the whole feature.

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { validateRef } from '../git-ref';
import type { GitBackedProject } from './types';

export const execFileAsync = promisify(execFile);

const refreshLocks = new Map<string, Promise<string>>();
const lastRefreshAt = new Map<string, number>();

function cacheRoot() {
  return process.env.KORTIX_GIT_CACHE_DIR || '/tmp/kortix/git-cache';
}

export function repoCachePath(project: GitBackedProject) {
  const id = createHash('sha256').update(project.projectId).digest('hex').slice(0, 32);
  return join(cacheRoot(), `${id}.git`);
}

function sessionBranchWorkRoot() {
  return process.env.KORTIX_GIT_BRANCH_WORK_DIR || join(dirname(cacheRoot()), 'git-session-branches');
}

export async function makeSessionBranchRepo(projectId: string) {
  const root = sessionBranchWorkRoot();
  await mkdir(root, { recursive: true });
  const id = createHash('sha256').update(projectId).digest('hex').slice(0, 12);
  return mkdtemp(join(root, `${id}-`));
}

/**
 * Host that serves the git protocol for a repo URL — used to scope the basic
 * auth header to the right origin. Falls back to github.com for unparseable
 * URLs (e.g. scp-style `git@host:org/repo`), which preserves the historical
 * GitHub-only behavior.
 */
export function hostFromRepoUrl(repoUrl?: string | null): string {
  if (!repoUrl) return 'github.com';
  try {
    return new URL(repoUrl).host;
  } catch {
    return 'github.com';
  }
}

function gitAuthEnv(token?: string | null, authHost = 'github.com'): Record<string, string> {
  if (!token) return {};
  const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.https://${authHost}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${encoded}`,
  };
}

export async function runGit(
  args: string[],
  cwd?: string,
  auth = true,
  authToken?: string | null,
  extraEnv?: Record<string, string>,
  authHost = 'github.com',
) {
  const authEnv = auth ? gitAuthEnv(authToken, authHost) : {};
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...authEnv, ...(extraEnv || {}) },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  } catch (error) {
    const err = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const stderr = err.stderr?.toString() || '';
    const stdout = err.stdout?.toString() || '';
    throw new Error((stderr || stdout || err.message || 'git failed').trim());
  }
}

/**
 * Like runGit, but never throws on non-zero exit codes — returns stdout, stderr
 * and exitCode. Use this for commands where a non-zero exit is part of the
 * expected control flow (e.g. `git merge-tree --write-tree` returns 1 when
 * conflicts are detected).
 */
export async function runGitCapture(
  args: string[],
  cwd?: string,
  authToken?: string | null,
  extraEnv?: Record<string, string>,
  authHost = 'github.com',
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...gitAuthEnv(authToken, authHost), ...(extraEnv || {}) },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: 0 };
  } catch (error) {
    const err = error as { stderr?: Buffer | string; stdout?: Buffer | string; code?: number };
    return {
      stdout: err.stdout?.toString() || '',
      stderr: err.stderr?.toString() || '',
      exitCode: typeof err.code === 'number' ? err.code : 1,
    };
  }
}

/** Re-export so callers that spawn directly (archive streaming) share one import surface. */
export { spawn };

function refreshIntervalMs() {
  const value = Number(process.env.KORTIX_GIT_REFRESH_INTERVAL_MS || 60_000);
  return Number.isFinite(value) && value >= 0 ? value : 60_000;
}

async function doRefreshMirror(project: GitBackedProject, force = false) {
  const repoPath = repoCachePath(project);
  await mkdir(dirname(repoPath), { recursive: true });
  if (existsSync(join(repoPath, 'shallow'))) {
    await rm(repoPath, { recursive: true, force: true });
  }
  if (!existsSync(repoPath)) {
    // Bare clone with ALL branches — required for the version/checkpoint
    // viewer. Older callers cloned --single-branch; we self-heal those on
    // refresh below by rewriting the fetch refspec.
    await runGit([
      'clone',
      '--bare',
      project.repoUrl,
      repoPath,
    ], undefined, true, project.gitAuthToken, undefined, hostFromRepoUrl(project.repoUrl));
    lastRefreshAt.set(project.projectId, Date.now());
    return repoPath;
  }

  const lastRefresh = lastRefreshAt.get(project.projectId) || 0;
  if (!force && Date.now() - lastRefresh < refreshIntervalMs()) return repoPath;

  await runGit(['remote', 'set-url', 'origin', project.repoUrl], repoPath);
  // Heal any legacy single-branch clones by widening the refspec.
  await runGit(['config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*'], repoPath, false);
  await runGit(['fetch', '--prune', 'origin'], repoPath, true, project.gitAuthToken, undefined, hostFromRepoUrl(project.repoUrl));
  lastRefreshAt.set(project.projectId, Date.now());
  return repoPath;
}

export async function refreshMirror(project: GitBackedProject, force = false) {
  const current = refreshLocks.get(project.projectId);
  if (current) return current;
  const next = doRefreshMirror(project, force).finally(() => refreshLocks.delete(project.projectId));
  refreshLocks.set(project.projectId, next);
  return next;
}

/**
 * Drop the "recently refreshed" marker for this project so the next mirror
 * read forces a fresh `git fetch`. Call this after committing/deleting a
 * file via the GitHub Contents API so the local cache lines up with the
 * upstream change.
 */
export function invalidateProjectMirror(projectId: string): void {
  lastRefreshAt.delete(projectId);
}

export function normalizeTreePath(input?: string | null) {
  if (!input || input === '.' || input === '/') return null;
  if (input.startsWith('/') || input.includes('..')) throw new Error('Invalid path');
  return input.replace(/^\.\/+/, '').replace(/\/+$/, '');
}

/**
 * Get the tree OID for a subtree at a given commit. This is git's own
 * content-addressed hash of every file under that path — perfect input
 * for snapshot cache invalidation: same files → same tree OID → same
 * snapshot. When `contextPath` is null/`.`/empty, returns the commit's
 * root tree OID.
 */
export async function resolveTreeOid(
  project: GitBackedProject,
  ref: string,
  contextPath?: string | null,
): Promise<string> {
  validateRef(ref);
  const repoPath = await refreshMirror(project);
  const normalized = normalizeTreePath(contextPath);
  if (!normalized) {
    // Root tree of the commit.
    const result = await runGit(['rev-parse', `${ref}^{tree}`], repoPath, false);
    const oid = result.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(oid)) {
      throw new Error(`Unexpected tree OID for ${ref}: ${oid}`);
    }
    return oid;
  }
  // ls-tree of the parent, parse the entry for normalized's basename.
  const result = await runGit(['ls-tree', ref, '--', normalized], repoPath, false);
  const line = result.stdout.split('\n').find((l) => l.trim());
  if (!line) throw new Error(`Path "${normalized}" not found at ${ref}`);
  const match = line.match(/^\d+\s+(tree|blob)\s+([0-9a-f]{40})\t/);
  if (!match) throw new Error(`Unparseable ls-tree line: ${line}`);
  return match[2]!;
}

/**
 * Materialize a subtree of the repo at a commit into a fresh local
 * directory — the snapshot builder feeds this to Daytona's Image API
 * which expects a local Dockerfile + context. Archives to a temporary tarball
 * before extraction so Bun child-process stream backpressure cannot truncate
 * large trees under load.
 *
 * Returns the absolute path where the context was extracted. Caller is
 * responsible for `rm -rf`ing it when done.
 */
export async function materializeRepoContext(
  project: GitBackedProject,
  ref: string,
  contextPath?: string | null,
): Promise<string> {
  validateRef(ref);
  const repoPath = await refreshMirror(project);
  const normalized = normalizeTreePath(contextPath);
  const treeish = normalized ? `${ref}:${normalized}` : ref;
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'kortix-snap-'));

  async function assertNoSymlinks(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const stat = await fs.lstat(fullPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Snapshot context contains unsupported symlink: ${path.relative(target, fullPath)}`);
      }
      if (stat.isDirectory()) {
        await assertNoSymlinks(fullPath);
      }
    }
  }

  const archivePath = `${target}.tar`;
  try {
    await runGit(['archive', '--format=tar', '-o', archivePath, treeish], repoPath, false);
    await execFileAsync('tar', ['-xf', archivePath, '-C', target], {
      env: { ...process.env },
      timeout: 60_000,
    });
    await scrubGeneratedSnapshotFiles(target);
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true });
    throw error;
  } finally {
    await fs.rm(archivePath, { force: true }).catch(() => {});
  }

  try {
    await assertNoSymlinks(target);
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true });
    throw error;
  }

  return target;
}

async function scrubGeneratedSnapshotFiles(root: string): Promise<void> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const removeIfPresent = async (relativePath: string) => {
    await fs.rm(path.join(root, relativePath), { recursive: true, force: true }).catch(() => {});
  };

  await Promise.all([
    removeIfPresent('.kortix/opencode/node_modules'),
    removeIfPresent('.kortix/opencode/package-lock.json'),
    removeIfPresent('.kortix/opencode/npm-shrinkwrap.json'),
    removeIfPresent('.kortix/opencode/pnpm-lock.yaml'),
    removeIfPresent('.kortix/opencode/yarn.lock'),
    removeIfPresent('.kortix/opencode/bun.lockb'),
  ]);

  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.name.startsWith('._')) {
        await fs.rm(fullPath, { recursive: true, force: true }).catch(() => {});
        return;
      }
      if (entry.isDirectory()) await walk(fullPath);
    }));
  }

  await walk(root);
}
