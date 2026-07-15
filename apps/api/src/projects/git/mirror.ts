// Shared core for the git-backed-project operations module.
//
// Owns the module-level mirror cache + the private clone/mirror/exec internals
// + the path-normalization helper. Every other git/* module imports from here
// (and from ./types). Keep all shared mutable state in THIS module so there is
// a single mirror cache across the whole feature.

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { validateRef } from '../git-ref';
import type { GitBackedProject } from './types';

export const execFileAsync = promisify(execFile);

const refreshLocks = new Map<string, Promise<string>>();
const lastRefreshAt = new Map<string, number>();

/**
 * The per-project bare mirror is a SHARED resource: session provisioning, the
 * version/checkpoint viewer, file browser, manifest/trigger/connector sync, the
 * warm-snapshot baker and background rebuilds all reach it through
 * `refreshMirror()`. The auth token is supplied per-call as
 * `project.gitAuthToken`, and several of those callers legitimately resolve it
 * to null (e.g. `.catch(() => null)` on a transient resolve, or a project shape
 * built before auth is known). Because `refreshMirror()` dedups concurrent
 * refreshes by projectId, a single tokenless caller winning the lock makes the
 * cold bare-clone of a PRIVATE repo run unauthenticated
 * (`fatal: could not read Username for 'https://github.com'`) — failing every
 * concurrent caller that piggybacks on that one shared clone, including a
 * token-bearing session start.
 *
 * Guarantee a token before any network git op: if the caller didn't pass one,
 * resolve it lazily from the project's stored credentials. Dynamic import keeps
 * this leaf module free of a static dependency on `../lib/git` (which transitively
 * pulls in the mirror), and the resolver itself never throws.
 */
async function ensureMirrorAuthToken(project: GitBackedProject): Promise<string | null> {
  if (project.gitAuthToken) return project.gitAuthToken;
  try {
    const { resolveProjectGitAuthTokenById } = await import('../lib/git');
    return await resolveProjectGitAuthTokenById(project.projectId);
  } catch (err) {
    console.warn(
      `[git-mirror] lazy auth resolve failed for ${project.projectId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

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

/** Default per-op timeout for `runGit` (ms). Bare clones override this via `timeoutMs`. */
const GIT_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Benign git progress / informational lines that git writes to **stderr** even
 * on a SUCCESSFUL run (`Cloning into …`, `remote:`, `Counting objects`, …) and
 * that are therefore the FIRST — and on a mid-clone timeout often the ONLY —
 * stderr a killed `git clone`/`git fetch` leaves behind. Surfacing them as the
 * Error message hides the real cause (timeout / signal / `fatal:`) and produced
 * the recurring opaque Better Stack pattern `8d0cffbb…`
 * ("Cloning into bare repository '/tmp/kortix/git-cache/….git'…"). Strip them
 * so a surfaced git error shows its actual `fatal:` line (or nothing, when the
 * process was killed before emitting one).
 */
const GIT_PROGRESS_LINE_RE = /^(?:Cloning into|remote:|Counting objects|Compressing objects|Receiving objects|Resolving deltas|From |\s*\d+%|\s*remote:)/;

export function stripGitProgress(text: string): string {
  if (!text) return '';
  return text
    .split('\n')
    .filter((line) => line.trim() !== '' && !GIT_PROGRESS_LINE_RE.test(line))
    .join('\n')
    .trim();
}

/**
 * Typed error thrown by `runGit` (and anything downstream of a bare-clone /
 * fetch failure). Replaces the old `throw new Error(stderr || stdout || …)`
 * which surfaced git's harmless `Cloning into bare repository …` progress line
 * — the only stderr a SIGTERM'd mid-clone leaves — as the Sentry message,
 * completely masking the real timeout/signal cause (Better Stack `8d0cffbb…`).
 *
 * `kind: 'timeout'` marks a transient, retryable failure (process killed /
 * SIGTERM'd / exceeded the timeout). The global `onError` classifies those into
 * a retryable 503 + Retry-After WITHOUT paging Sentry (mirroring the Platinum
 * / request-deadline de-noise pattern), since the mirror's own retry usually
 * clears them and they are upstream/network noise, not a code bug.
 * `kind: 'failed'` is a real non-zero exit (auth, missing repo, bad ref) —
 * still surfaced to Sentry, but now with a meaningful `fatal:` message instead
 * of progress noise.
 */
export class GitOperationError extends Error {
  readonly kind: 'timeout' | 'failed';
  readonly gitArgs: readonly string[];
  readonly signal: string | null;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  constructor(opts: {
    kind: 'timeout' | 'failed';
    message: string;
    gitArgs: readonly string[];
    signal?: string | null;
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
    cause?: unknown;
  }) {
    super(opts.message, { cause: opts.cause });
    this.name = 'GitOperationError';
    this.kind = opts.kind;
    this.gitArgs = opts.gitArgs;
    this.signal = opts.signal ?? null;
    this.exitCode = opts.exitCode ?? null;
    this.stdout = opts.stdout ?? '';
    this.stderr = opts.stderr ?? '';
  }
}

/**
 * Pure classifier (unit-testable without a real git process): turn a Node
 * `execFile` rejection into a typed `GitOperationError`. A killed/timed-out
 * process (signal set, or Node's "timed out" message) is `kind: 'timeout'`
 * with a message naming the timeout + signal — NEVER the partial `Cloning
 * into …` progress line Node captured on stderr before the kill. A normal
 * non-zero exit is `kind: 'failed'` with the real `fatal:` line (progress
 * stripped).
 */
export function classifyGitError(error: unknown, args: readonly string[], timeoutMs: number): GitOperationError {
  const err = error as {
    stderr?: Buffer | string;
    stdout?: Buffer | string;
    message?: string;
    code?: string | number;
    signal?: string;
    killed?: boolean;
  };
  const stderr = err.stderr?.toString() || '';
  const stdout = err.stdout?.toString() || '';
  const signal = err.signal ?? null;
  const killed = Boolean(err.killed);
  const msg = err.message || '';
  // Node fires `killed: true` + `signal: 'SIGTERM'` (no numeric exitCode) when
  // the `timeout` elapses, OR sets `code: 'ETIMEDOUT'`. Either way the real
  // cause is the timeout — the stderr git managed to write before being killed
  // is just the `Cloning into …` / `remote: …` progress line and must NOT
  // become the message.
  const isTimeout = killed || Boolean(signal) || msg.includes('timed out') || err.code === 'ETIMEDOUT';
  const subcommand = args[0] || 'git';
  if (isTimeout) {
    const detail = signal ? ` (signal ${signal})` : '';
    return new GitOperationError({
      kind: 'timeout',
      message: `git ${subcommand} timed out after ${timeoutMs}ms${detail}`,
      gitArgs: args,
      signal,
      exitCode: null,
      stdout,
      stderr,
      cause: error,
    });
  }
  const cleaned = stripGitProgress(stderr) || stripGitProgress(stdout) || msg || 'git failed';
  return new GitOperationError({
    kind: 'failed',
    message: cleaned,
    gitArgs: args,
    signal,
    exitCode: typeof err.code === 'number' ? err.code : null,
    stdout,
    stderr,
    cause: error,
  });
}

export function isGitOperationError(err: unknown): err is GitOperationError {
  return err instanceof GitOperationError;
}

export async function runGit(
  args: string[],
  cwd?: string,
  auth = true,
  authToken?: string | null,
  extraEnv?: Record<string, string>,
  authHost = 'github.com',
  timeoutMs: number = GIT_DEFAULT_TIMEOUT_MS,
) {
  const authEnv = auth ? gitAuthEnv(authToken, authHost) : {};
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...authEnv, ...(extraEnv || {}) },
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  } catch (error) {
    throw classifyGitError(error, args, timeoutMs);
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

/** Per-op timeout (ms) for a cold bare `git clone --bare` of a project mirror. */
function bareCloneTimeoutMs(): number {
  const value = Number(process.env.KORTIX_GIT_BARE_CLONE_TIMEOUT_MS || 90_000);
  return Number.isFinite(value) && value > 0 ? value : 90_000;
}

const BARE_CLONE_TIMEOUT_MS = bareCloneTimeoutMs();
/** Cold clones can transiently exceed the timeout (large repo / network blip);
 * retry once before surfacing — most timeouts clear on a 2nd attempt. */
const BARE_CLONE_MAX_ATTEMPTS = 2;
const BARE_CLONE_RETRY_DELAY_MS = 500;

async function doRefreshMirror(project: GitBackedProject, force = false) {
  const repoPath = repoCachePath(project);
  await mkdir(dirname(repoPath), { recursive: true });
  if (existsSync(join(repoPath, 'shallow'))) {
    await rm(repoPath, { recursive: true, force: true });
  }
  const needsClone = !existsSync(repoPath);
  const lastRefresh = lastRefreshAt.get(project.projectId) || 0;
  const needsFetch = !needsClone && (force || Date.now() - lastRefresh >= refreshIntervalMs());
  // Nothing to do over the network — serve the warm cache without touching git.
  if (!needsClone && !needsFetch) return repoPath;

  // Resolve a token before EITHER network op. Whichever caller wins the
  // refresh lock, the shared clone/fetch is authenticated whenever the project
  // has a resolvable credential — eliminating the "tokenless caller poisons a
  // private-repo clone" race described on `ensureMirrorAuthToken`.
  const authToken = await ensureMirrorAuthToken(project);
  const authHost = hostFromRepoUrl(project.repoUrl);

  if (needsClone) {
    // Bare clone with ALL branches — required for the version/checkpoint
    // viewer. Older callers cloned --single-branch; we self-heal those on
    // refresh below by rewriting the fetch refspec.
    //
    // Cold clones of large repos legitimately exceed the default 30s `runGit`
    // timeout; a SIGTERM mid-transfer leaves only git's `Cloning into …`
    // progress line on stderr (the root of the recurring opaque Better Stack
    // pattern `8d0cffbb…`) AND — critically — leaves a partial `.git` dir
    // with no `shallow` marker, so the next access sees `existsSync(repoPath)`
    // true, skips the clone, and tries to `fetch` from a broken half-repo,
    // wedging every reader for the process lifetime. So: give the cold clone a
    // longer budget, retry once on a transient timeout, and ALWAYS remove the
    // partial dir on failure so the next caller re-clones cleanly.
    const cloneArgs = ['clone', '--bare', project.repoUrl, repoPath] as const;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= BARE_CLONE_MAX_ATTEMPTS; attempt++) {
      try {
        await runGit([...cloneArgs], undefined, true, authToken, undefined, authHost, BARE_CLONE_TIMEOUT_MS);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        // Remove the partial bare repo a killed/failed clone leaves behind.
        await rm(repoPath, { recursive: true, force: true }).catch(() => {});
        const transient = err instanceof GitOperationError && err.kind === 'timeout';
        if (attempt >= BARE_CLONE_MAX_ATTEMPTS || !transient) break;
        await new Promise((resolve) => setTimeout(resolve, BARE_CLONE_RETRY_DELAY_MS));
      }
    }
    if (lastErr) throw lastErr;
    lastRefreshAt.set(project.projectId, Date.now());
    return repoPath;
  }

  await runGit(['remote', 'set-url', 'origin', project.repoUrl], repoPath);
  // Heal any legacy single-branch clones by widening the refspec.
  await runGit(['config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*'], repoPath, false);
  await runGit(['fetch', '--prune', 'origin'], repoPath, true, authToken, undefined, authHost);
  lastRefreshAt.set(project.projectId, Date.now());
  return repoPath;
}

export async function refreshMirror(project: GitBackedProject, force = false) {
  const current = refreshLocks.get(project.projectId);
  if (current) return current;
  const next = doRefreshMirror(project, force)
    .then(async (repoPath) => {
      // Bump the mirror dir's mtime on EVERY access (warm hits included) — the
      // size-budget reaper below uses it as the LRU signal, and a warm read
      // must not look idle just because no fetch ran.
      const now = new Date();
      await utimes(repoPath, now, now).catch(() => {});
      return repoPath;
    })
    .finally(() => refreshLocks.delete(project.projectId));
  refreshLocks.set(project.projectId, next);
  return next;
}

function gitCacheMaxBytes(): number {
  const raw = Number(process.env.KORTIX_GIT_CACHE_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 4 * 1024 * 1024 * 1024;
}

// Must stay SHORT: the connector sweep re-touches every mirror on the platform
// each pass (~11min), so a grace window near the pass duration would shield the
// whole cache from eviction. It only has to outlive a single in-flight git read
// that started right after a refreshMirror() touch (seconds, not minutes).
const GIT_CACHE_EVICT_GRACE_MS = 5 * 60 * 1000;

async function dirSizeBytes(root: string): Promise<number> {
  let total = 0;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      total += await dirSizeBytes(full);
    } else if (entry.isFile()) {
      const s = await stat(full).catch(() => null);
      if (s) total += s.size;
    }
  }
  return total;
}

/**
 * Enforce a total size budget on the bare-mirror cache. The trigger/connector
 * sweeps walk EVERY active project's manifest through `refreshMirror()`, so the
 * leader pod accumulates a full clone of every repo on the platform — unbounded,
 * this fills the pod's ephemeral-storage limit and kubelet EVICTS the pod
 * (observed: 19 prod api evictions 2026-07-05→07 at the 8Gi cap). Evict
 * least-recently-used mirrors until under budget; a mirror touched within the
 * grace window is never removed (refreshMirror bumps mtime on every access, so
 * anything an in-flight git op could be reading is inside the grace window).
 * Deleting a live mirror is safe-by-design anyway: the next access re-clones.
 */
export async function reapGitCacheOverBudget(
  maxBytes = gitCacheMaxBytes(),
): Promise<{ totalBytes: number; deleted: number; freedBytes: number }> {
  const root = cacheRoot();
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return { totalBytes: 0, deleted: 0, freedBytes: 0 };
  }

  const mirrors: Array<{ path: string; bytes: number; mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.endsWith('.git')) continue;
    const path = join(root, name);
    try {
      const s = await stat(path);
      if (!s.isDirectory()) continue;
      mirrors.push({ path, bytes: await dirSizeBytes(path), mtimeMs: s.mtimeMs });
    } catch {
      // racing clone or already gone — skip
    }
  }

  let totalBytes = mirrors.reduce((sum, m) => sum + m.bytes, 0);
  if (totalBytes <= maxBytes) return { totalBytes, deleted: 0, freedBytes: 0 };

  const now = Date.now();
  let deleted = 0;
  let freedBytes = 0;
  mirrors.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const mirror of mirrors) {
    if (totalBytes <= maxBytes) break;
    if (now - mirror.mtimeMs < GIT_CACHE_EVICT_GRACE_MS) break;
    try {
      await rm(mirror.path, { recursive: true, force: true });
      totalBytes -= mirror.bytes;
      freedBytes += mirror.bytes;
      deleted++;
    } catch {
      // in use or perms — leave it for the next sweep
    }
  }
  return { totalBytes, deleted, freedBytes };
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
