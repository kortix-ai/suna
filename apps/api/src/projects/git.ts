import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createBranchRef, getBranchCommitSha, parseGitHubRepoUrl } from './github';

const execFileAsync = promisify(execFile);

export interface GitBackedProject {
  projectId: string;
  repoUrl: string;
  defaultBranch: string;
  manifestPath: string;
  gitAuthToken?: string | null;
}

export interface ProjectFileEntry {
  path: string;
  type: 'file';
  size: number | null;
}

export interface ProjectConfigSummary {
  is_kortix_repo: boolean;
  signals: Record<string, boolean>;
  manifest_raw: string | null;
  manifest: Record<string, unknown>;
  env: { required: string[]; optional: string[] };
  open_code_raw: string | null;
  open_code_default_agent: string | null;
  agents: Array<{ name: string; path: string; description: string | null; mode: string | null }>;
  skills: Array<{ name: string; path: string; description: string | null }>;
  commands: Array<{ name: string; path: string; description: string | null }>;
}

const refreshLocks = new Map<string, Promise<string>>();
const lastRefreshAt = new Map<string, number>();

function cacheRoot() {
  return process.env.KORTIX_GIT_CACHE_DIR || '/tmp/kortix/git-cache';
}

function repoCachePath(project: GitBackedProject) {
  const id = createHash('sha256').update(project.projectId).digest('hex').slice(0, 32);
  return join(cacheRoot(), `${id}.git`);
}

function sessionBranchWorkRoot() {
  return process.env.KORTIX_GIT_BRANCH_WORK_DIR || join(dirname(cacheRoot()), 'git-session-branches');
}

async function makeSessionBranchRepo(projectId: string) {
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
function hostFromRepoUrl(repoUrl?: string | null): string {
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

async function runGit(
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
async function runGitCapture(
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

async function refreshMirror(project: GitBackedProject, force = false) {
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

function normalizeTreePath(input?: string | null) {
  if (!input || input === '.' || input === '/') return null;
  if (input.startsWith('/') || input.includes('..')) throw new Error('Invalid path');
  return input.replace(/^\.\/+/, '').replace(/\/+$/, '');
}

export async function listRepoFiles(project: GitBackedProject, ref?: string, path?: string | null): Promise<ProjectFileEntry[]> {
  const repoPath = await refreshMirror(project);
  const treeRef = ref || project.defaultBranch;
  const treePath = normalizeTreePath(path);
  const args = ['ls-tree', '-r', treeRef, '--'];
  if (treePath) args.push(treePath);
  const result = await runGit(args, repoPath, false);
  if (!result.stdout.trim()) return [];
  return result.stdout
    .split('\n')
    .map<ProjectFileEntry | null>((line) => {
      const match = line.match(/^\d+\s+(\w+)\s+[0-9a-f]+\t(.+)$/);
      if (!match || match[1] !== 'blob') return null;
      return { path: match[2] || '', type: 'file', size: null };
    })
    .filter((entry): entry is ProjectFileEntry => Boolean(entry));
}

export interface RepoGrepMatch {
  path: string;
  line_number: number;
  line_text: string;
}

/**
 * Filename search over the repo tree. Lists files via `listRepoFiles` then
 * ranks by a case-insensitive match (basename prefix > basename substring >
 * path substring), shortest path first.
 */
export async function searchRepoFileNames(
  project: GitBackedProject,
  query: string,
  ref?: string,
  limit = 50,
): Promise<ProjectFileEntry[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const files = await listRepoFiles(project, ref);
  return files
    .map((f) => {
      const path = f.path.toLowerCase();
      const base = path.split('/').pop() || path;
      let score = -1;
      if (base.startsWith(q)) score = 0;
      else if (base.includes(q)) score = 1;
      else if (path.includes(q)) score = 2;
      return score >= 0 ? { f, score } : null;
    })
    .filter((x): x is { f: ProjectFileEntry; score: number } => Boolean(x))
    .sort((a, b) => a.score - b.score || a.f.path.length - b.f.path.length)
    .slice(0, limit)
    .map((x) => x.f);
}

/**
 * Content search via `git grep` over the tree at `ref`. Fixed-string,
 * case-insensitive, skips binaries. Returns flat path/line/text matches.
 * `git grep` exits non-zero when there are no matches, so we use the
 * non-throwing capture variant.
 */
export async function grepRepoFiles(
  project: GitBackedProject,
  pattern: string,
  ref?: string,
  limit = 50,
): Promise<RepoGrepMatch[]> {
  const q = pattern.trim();
  if (!q) return [];
  const repoPath = await refreshMirror(project);
  const treeRef = ref || project.defaultBranch;
  const result = await runGitCapture(
    ['grep', '-n', '-I', '-i', '-F', '-m', '10', '-e', q, treeRef],
    repoPath,
  );
  if (!result.stdout.trim()) return [];
  const matches: RepoGrepMatch[] = [];
  const prefix = `${treeRef}:`;
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    // With a tree ref, git grep prints "<ref>:<path>:<lineno>:<text>".
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    let path = m[1];
    if (path.startsWith(prefix)) path = path.slice(prefix.length);
    matches.push({
      path,
      line_number: Number(m[2]),
      line_text: (m[3] || '').slice(0, 400),
    });
    if (matches.length >= limit) break;
  }
  return matches;
}

export async function readRepoFile(project: GitBackedProject, filePath: string, ref?: string) {
  const normalized = normalizeTreePath(filePath);
  if (!normalized) throw new Error('File path is required');
  const repoPath = await refreshMirror(project);
  const treeRef = ref || project.defaultBranch;
  const result = await runGit(['show', `${treeRef}:${normalized}`], repoPath, false);
  return result.stdout;
}

/**
 * Resolve a ref (branch name, tag, "HEAD") to a full 40-char commit SHA.
 * Used by the snapshot builder to pin a build to a specific commit even
 * when the default branch moves underneath it.
 */
export async function resolveCommitSha(project: GitBackedProject, ref?: string): Promise<string> {
  const repoPath = await refreshMirror(project);
  const treeRef = ref || project.defaultBranch;
  const result = await runGit(['rev-parse', '--verify', `${treeRef}^{commit}`], repoPath, false);
  const sha = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`Unexpected git rev-parse output for ${treeRef}: ${sha}`);
  }
  return sha;
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

/**
 * Stream a zip archive of the repo (or a subtree) at the given ref.
 *
 * Uses `git archive --format=zip` so the work happens server-side and the
 * client just downloads the bytes — no client-side zipping required.
 * When `path` is null, archives the whole tree; otherwise archives the
 * subtree at that path with the subtree as the zip root.
 */
export async function archiveRepoSubtree(
  project: GitBackedProject,
  ref: string | undefined,
  path?: string | null,
): Promise<ReadableStream<Uint8Array>> {
  const repoPath = await refreshMirror(project);
  const treeRef = ref || project.defaultBranch;
  const normalized = path ? normalizeTreePath(path) : null;
  const treeish = normalized ? `${treeRef}:${normalized}` : treeRef;

  const proc = spawn('git', ['archive', '--format=zip', treeish], {
    cwd: repoPath,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });

  let stderr = '';
  proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

  return new ReadableStream<Uint8Array>({
    start(controller) {
      proc.stdout.on('data', (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      proc.stdout.on('end', () => {
        // Wait for process exit before closing so we can surface non-zero exits.
        if (proc.exitCode === null) {
          proc.once('close', (code) => {
            if (code !== 0) {
              controller.error(new Error(stderr.trim() || `git archive exited ${code}`));
            } else {
              controller.close();
            }
          });
        } else if (proc.exitCode !== 0) {
          controller.error(new Error(stderr.trim() || `git archive exited ${proc.exitCode}`));
        } else {
          controller.close();
        }
      });
      proc.stdout.on('error', (err) => controller.error(err));
      proc.on('error', (err) => controller.error(err));
    },
    cancel() {
      try { proc.kill(); } catch { /* ignore */ }
    },
  });
}

export async function createRemoteSessionBranch(
  project: GitBackedProject,
  branchName: string,
  baseRef?: string,
) {
  const base = validateRef(baseRef || project.defaultBranch);
  const branch = validateRef(branchName);
  const githubRepo = parseGitHubRepoUrl(project.repoUrl);
  if (githubRepo && project.gitAuthToken) {
    const auth = { token: project.gitAuthToken };
    const sha = await getBranchCommitSha({
      owner: githubRepo.owner,
      repo: githubRepo.repo,
      branch: base,
      auth,
    });
    await createBranchRef({
      owner: githubRepo.owner,
      repo: githubRepo.repo,
      branch,
      sha,
      auth,
    });
    invalidateProjectMirror(project.projectId);
    return;
  }

  const authHost = hostFromRepoUrl(project.repoUrl);
  const repoPath = await makeSessionBranchRepo(project.projectId);

  try {
    // Session start only needs the base branch tip so it can push a new branch.
    // Avoid the shared full bare mirror here: first-session startup should not
    // block on cloning every branch and all history from large repos.
    await runGit(['init', '--bare', repoPath], undefined, false);
    await runGit(['remote', 'add', 'origin', project.repoUrl], repoPath, false);
    await runGit(
      ['fetch', '--no-tags', '--depth=1', 'origin', `+refs/heads/${base}:refs/heads/${base}`],
      repoPath,
      true,
      project.gitAuthToken,
      undefined,
      authHost,
    );
    await runGit(
      ['push', 'origin', `refs/heads/${base}:refs/heads/${branch}`],
      repoPath,
      true,
      project.gitAuthToken,
      undefined,
      authHost,
    );
    invalidateProjectMirror(project.projectId);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
}

export async function deleteRemoteSessionBranch(
  project: GitBackedProject,
  branchName: string,
): Promise<boolean> {
  if (!branchName || branchName === project.defaultBranch) {
    throw new Error('Refusing to delete the project default branch');
  }

  const authHost = hostFromRepoUrl(project.repoUrl);
  const repoPath = await refreshMirror(project, true);
  const remote = await runGit(['ls-remote', '--heads', 'origin', branchName], repoPath, true, project.gitAuthToken, undefined, authHost)
    .catch(() => ({ stdout: '', stderr: '' }));
  if (!remote.stdout.trim()) return false;

  await runGit(['push', 'origin', `:${branchName}`], repoPath, true, project.gitAuthToken, undefined, authHost);
  await runGit(['update-ref', '-d', `refs/heads/${branchName}`], repoPath, false)
    .catch(() => undefined);
  return true;
}

/**
 * Commit a single file's contents onto `branch` and push — provider-agnostic.
 * Works for GitHub, Freestyle managed git, GitLab, or any HTTPS git remote,
 * unlike the GitHub Contents-API path which only understands github.com URLs.
 *
 * Implemented with git plumbing in the bare mirror: hash the new blob, splice
 * it into the branch tip's tree through a throwaway index, `commit-tree`, then
 * push. If the branch doesn't exist yet (brand-new repo) it's created from an
 * empty tree. Returns the new commit SHA.
 */
export async function commitFileToBranch(
  project: GitBackedProject,
  opts: {
    path: string;
    content: string;
    message: string;
    branch?: string;
    authorName?: string;
    authorEmail?: string;
  },
): Promise<{ commitSha: string }> {
  const filePath = normalizeTreePath(opts.path);
  if (!filePath) throw new Error('File path is required');
  const branch = validateRef(opts.branch || project.defaultBranch);
  const authHost = hostFromRepoUrl(project.repoUrl);
  // Force a fresh fetch so the parent we build on is the real remote tip; the
  // non-force push below then fails cleanly if a concurrent write raced us.
  const repoPath = await refreshMirror(project, true);

  // Branch tip, if the branch already exists (absent on a fresh repo).
  const tip = await runGitCapture(['rev-parse', '--verify', `refs/heads/${branch}`], repoPath);
  const parentSha = tip.exitCode === 0 ? tip.stdout.trim() : null;

  const author = opts.authorName || 'Kortix';
  const email = opts.authorEmail || 'noreply@kortix.ai';
  const identEnv = {
    GIT_AUTHOR_NAME: author,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: author,
    GIT_COMMITTER_EMAIL: email,
  };

  // Scratch blob + index files inside the bare mirror dir; cleaned up below.
  const suffix = createHash('sha256')
    .update(`${branch}:${filePath}:${Date.now()}:${Math.random()}`)
    .digest('hex')
    .slice(0, 16);
  const blobFile = join(repoPath, `.kortix-blob-${suffix}`);
  const indexFile = join(repoPath, `.kortix-index-${suffix}`);
  const indexEnv = { GIT_INDEX_FILE: indexFile };

  try {
    await writeFile(blobFile, opts.content);
    const blobSha = (await runGit(['hash-object', '-w', blobFile], repoPath, false)).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(blobSha)) throw new Error('git hash-object did not return a blob SHA');

    // Seed the throwaway index from the parent tree (or empty), splice the file.
    if (parentSha) await runGit(['read-tree', parentSha], repoPath, false, null, indexEnv);
    else await runGit(['read-tree', '--empty'], repoPath, false, null, indexEnv);
    await runGit(
      ['update-index', '--add', '--cacheinfo', `100644,${blobSha},${filePath}`],
      repoPath,
      false,
      null,
      indexEnv,
    );
    const treeSha = (await runGit(['write-tree'], repoPath, false, null, indexEnv)).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(treeSha)) throw new Error('git write-tree did not return a tree SHA');

    const commitArgs = ['commit-tree', treeSha];
    if (parentSha) commitArgs.push('-p', parentSha);
    commitArgs.push('-m', opts.message);
    const commitSha = (await runGit(commitArgs, repoPath, false, null, identEnv)).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error('git commit-tree did not return a commit SHA');

    // Advance the local ref (compare-and-swap when we knew the tip) and push.
    if (parentSha) await runGit(['update-ref', `refs/heads/${branch}`, commitSha, parentSha], repoPath, false);
    else await runGit(['update-ref', `refs/heads/${branch}`, commitSha], repoPath, false);
    await runGit(
      ['push', 'origin', `${commitSha}:refs/heads/${branch}`],
      repoPath,
      true,
      project.gitAuthToken,
      undefined,
      authHost,
    );

    invalidateProjectMirror(project.projectId);
    return { commitSha };
  } finally {
    await rm(blobFile, { force: true }).catch(() => undefined);
    await rm(indexFile, { force: true }).catch(() => undefined);
  }
}

export async function diffStat(project: GitBackedProject, branchName: string, baseRef?: string) {
  const repoPath = await refreshMirror(project);
  const base = baseRef || project.defaultBranch;
  const result = await runGit(['diff', '--stat', `refs/heads/${base}...refs/heads/${branchName}`], repoPath, false)
    .catch(() => ({ stdout: '', stderr: '' }));
  return { text: result.stdout };
}

async function optionalFile(project: GitBackedProject, filePath: string) {
  try {
    return await readRepoFile(project, filePath, project.defaultBranch);
  } catch {
    return null;
  }
}

function stripTomlComment(line: string) {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if ((ch === '"' || ch === "'") && line[i - 1] !== '\\') {
      quote = quote === ch ? null : quote || ch;
      continue;
    }
    if (ch === '#' && !quote) return line.slice(0, i);
  }
  return line;
}

function parseTomlValue(rawValue: string): unknown {
  const value = rawValue.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return Array.from(inner.matchAll(/"([^"]*)"|'([^']*)'|([^,\s][^,]*)/g))
      .map((match) => (match[1] ?? match[2] ?? match[3] ?? '').trim())
      .filter(Boolean);
  }
  if (value === 'true' || value === 'false') return value === 'true';
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function parseManifest(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  const out: Record<string, unknown> = {};
  let section: Record<string, unknown> = out;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = stripTomlComment(line).trim();
    if (!trimmed) continue;
    const sectionMatch = trimmed.match(/^\[([a-zA-Z0-9_.-]+)]$/);
    if (sectionMatch) {
      const next: Record<string, unknown> = {};
      out[sectionMatch[1]] = next;
      section = next;
      continue;
    }
    const kv = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    section[kv[1]] = parseTomlValue(kv[2].trim());
  }
  return out;
}

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const key = item.trim().toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function envRequirements(manifest: Record<string, unknown>) {
  const env = typeof manifest.env === 'object' && manifest.env ? manifest.env as Record<string, unknown> : {};
  return {
    required: asStringArray(env.required),
    optional: asStringArray(env.optional),
  };
}

function parseJsonCString(raw: string | null, key: string) {
  if (!raw) return null;
  const match = raw.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
  return match?.[1] || null;
}

function parseFrontmatter(raw: string | null) {
  if (!raw?.startsWith('---')) return {};
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return {};
  const meta: Record<string, string> = {};
  for (const line of raw.slice(3, end).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (!match) continue;
    meta[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return meta;
}

function agentNameFromPath(path: string) {
  return path.split('/').pop()?.replace(/\.md$/, '') || path;
}

export async function loadProjectConfig(project: GitBackedProject, files?: ProjectFileEntry[]): Promise<ProjectConfigSummary> {
  const repoFiles = files ?? await listRepoFiles(project, project.defaultBranch);
  const manifestRaw = await optionalFile(project, project.manifestPath);
  const manifest = parseManifest(manifestRaw);
  const opencodeDir = resolveOpencodeDir(manifest);
  // Where opencode.jsonc lives. Path comes from the manifest's
  // [opencode] config_dir, defaulting to `.kortix/opencode`.
  const openCodeRaw = await optionalFile(project, `${opencodeDir}/opencode.jsonc`);

  // Build matchers off the configured opencode dir. The trailing
  // `s?` on agents/commands is opencode's own historical quirk (it
  // accepts both `agent/` and `agents/`); we follow suit.
  const escapedDir = escapeRegExp(opencodeDir);
  const agentRe = new RegExp(`^${escapedDir}/agents?/[^/]+\\.md$`);
  const skillRe = new RegExp(`^${escapedDir}/skills/(.+)/SKILL\\.md$`);
  const commandRe = new RegExp(`^${escapedDir}/commands?/([^/]+)\\.md$`);

  const agentPaths = repoFiles
    .map((file) => file.path)
    .filter((path) => agentRe.test(path))
    .sort();
  const agents = await Promise.all(agentPaths.map(async (path) => {
    const raw = await optionalFile(project, path);
    const meta = parseFrontmatter(raw);
    return {
      name: meta.name || meta.slug || agentNameFromPath(path),
      path,
      description: meta.description || null,
      mode: meta.mode || null,
    };
  }));

  const seenSkills = new Set<string>();
  const skillPaths = repoFiles
    .map((file) => file.path.match(skillRe))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .filter((match) => {
      if (seenSkills.has(match[1])) return false;
      seenSkills.add(match[1]);
      return true;
    })
    .map((match) => ({ slug: match[1], path: `${opencodeDir}/skills/${match[1]}/SKILL.md` }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const skills = await Promise.all(skillPaths.map(async ({ slug, path }) => {
    const raw = await optionalFile(project, path);
    const meta = parseFrontmatter(raw);
    return {
      name: meta.name || slug,
      path,
      description: meta.description || null,
    };
  }));

  // OpenCode slash commands — `<opencode>/command/<slug>.md` or
  // `<opencode>/commands/<slug>.md` (both forms accepted by the runtime; we
  // include either if present). Frontmatter `description:` is what gets
  // surfaced in the command picker.
  const commandPaths = repoFiles
    .map((file) => file.path.match(commandRe))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({ slug: match[1], path: match.input as string }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const commands = await Promise.all(commandPaths.map(async ({ slug, path }) => {
    const raw = await optionalFile(project, path);
    const meta = parseFrontmatter(raw);
    return {
      name: meta.name || slug,
      path,
      description: meta.description || null,
    };
  }));

  const signals = {
    manifest: Boolean(manifestRaw),
    openCodeConfig: Boolean(openCodeRaw),
    openCodeAgent: agents.length > 0,
  };

  return {
    is_kortix_repo: Object.values(signals).some(Boolean),
    signals,
    manifest_raw: manifestRaw,
    manifest,
    env: envRequirements(manifest),
    open_code_raw: openCodeRaw,
    open_code_default_agent: parseJsonCString(openCodeRaw, 'default_agent'),
    agents,
    skills,
    commands,
  };
}

/**
 * Resolve `[opencode] config_dir` from the parsed manifest. Mirrors the
 * default from triggers.ts (DEFAULT_OPENCODE_CONFIG_DIR) but kept local
 * to avoid a circular import — git.ts is depended on by triggers.ts.
 */
function resolveOpencodeDir(manifest: Record<string, unknown>): string {
  const opencode = manifest.opencode;
  if (opencode && typeof opencode === 'object' && !Array.isArray(opencode)) {
    const raw = (opencode as Record<string, unknown>).config_dir;
    if (typeof raw === 'string' && raw.trim()) {
      const trimmed = raw.trim();
      // Reject absolute paths + `..` segments here too. parseManifestString
      // already validates the same on the trigger path; this is a
      // belt-and-suspenders since loadProjectConfig uses its own parser.
      if (!trimmed.startsWith('/') && !trimmed.split('/').includes('..')) {
        return trimmed.replace(/\/+$/, '');
      }
    }
  }
  return '.kortix/opencode';
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Branches / commits / diffs — drives the Versions (branches) and Checkpoints
// (commits) panels in the project file viewer. Internal types still use Git
// vocabulary; user-facing strings are translated in the web layer.
// ---------------------------------------------------------------------------

export interface GitBranchInfo {
  name: string;
  is_default: boolean;
  tip: string;
  tip_short: string;
  subject: string;
  committer_name: string;
  committer_email: string;
  committed_at: string;
  ahead: number | null;
  behind: number | null;
}

export interface GitLogEntry {
  hash: string;
  short_hash: string;
  parents: string[];
  author_name: string;
  author_email: string;
  authored_at: string;
  committer_name: string;
  committer_email: string;
  committed_at: string;
  subject: string;
  body: string;
}

export interface GitCommitFile {
  path: string;
  old_path: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange';
  additions: number;
  deletions: number;
}

export interface GitCommitDetail extends GitLogEntry {
  files: GitCommitFile[];
}

const FIELD_SEP = '';
const RECORD_SEP = '';
const LOG_FORMAT = [
  '%H',
  '%h',
  '%P',
  '%an',
  '%ae',
  '%aI',
  '%cn',
  '%ce',
  '%cI',
  '%s',
  '%b',
].join(FIELD_SEP) + RECORD_SEP;

function parseLogStdout(stdout: string): GitLogEntry[] {
  return stdout
    .split(RECORD_SEP)
    .map((chunk) => chunk.replace(/^\n+/, ''))
    .filter((chunk) => chunk.length > 0)
    .map<GitLogEntry | null>((chunk) => {
      const parts = chunk.split(FIELD_SEP);
      if (parts.length < 11) return null;
      const [
        hash,
        shortHash,
        parents,
        authorName,
        authorEmail,
        authoredAt,
        committerName,
        committerEmail,
        committedAt,
        subject,
        ...bodyParts
      ] = parts;
      return {
        hash,
        short_hash: shortHash,
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        author_name: authorName,
        author_email: authorEmail,
        authored_at: authoredAt,
        committer_name: committerName,
        committer_email: committerEmail,
        committed_at: committedAt,
        subject,
        body: bodyParts.join(FIELD_SEP).replace(/\s+$/, ''),
      };
    })
    .filter((entry): entry is GitLogEntry => entry !== null);
}

function decodeStatusChar(code: string): GitCommitFile['status'] {
  const head = code[0] || 'M';
  switch (head) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'typechange';
    default:
      return 'modified';
  }
}

function validateRef(ref: string): string {
  if (!ref) throw new Error('Ref is required');
  // git refs forbid: spaces, "..", "@{", "\\", control chars. Be conservative.
  if (!/^[A-Za-z0-9._\-\/]+$/.test(ref) || ref.includes('..') || ref.startsWith('-')) {
    throw new Error('Invalid ref');
  }
  return ref;
}

function validateSha(sha: string): string {
  if (!sha || !/^[0-9a-fA-F]{4,64}$/.test(sha)) throw new Error('Invalid commit hash');
  return sha;
}

export async function listBranches(project: GitBackedProject): Promise<GitBranchInfo[]> {
  const repoPath = await refreshMirror(project);
  const format = [
    '%(refname:short)',
    '%(objectname)',
    '%(objectname:short)',
    '%(subject)',
    '%(committername)',
    '%(committeremail)',
    '%(committerdate:iso-strict)',
  ].join(FIELD_SEP);
  const result = await runGit(
    ['for-each-ref', `--format=${format}`, '--sort=-committerdate', 'refs/heads/'],
    repoPath,
    false,
  );
  const lines = result.stdout.split('\n').filter(Boolean);
  const baseRef = project.defaultBranch;

  const branches = lines
    .map<GitBranchInfo | null>((line) => {
      const parts = line.split(FIELD_SEP);
      if (parts.length < 7) return null;
      const [name, tip, tipShort, subject, committerName, committerEmail, committedAt] = parts;
      return {
        name,
        is_default: name === baseRef,
        tip,
        tip_short: tipShort,
        subject,
        committer_name: committerName,
        committer_email: committerEmail
          .replace(/^</, '')
          .replace(/>$/, ''),
        committed_at: committedAt,
        ahead: null,
        behind: null,
      };
    })
    .filter((b): b is GitBranchInfo => b !== null);

  // Compute ahead/behind vs default in parallel (skip the default itself).
  await Promise.all(
    branches.map(async (b) => {
      if (b.is_default) {
        b.ahead = 0;
        b.behind = 0;
        return;
      }
      try {
        const rl = await runGit(
          ['rev-list', '--left-right', '--count', `${baseRef}...${b.name}`],
          repoPath,
          false,
        );
        const match = rl.stdout.trim().match(/^(\d+)\s+(\d+)/);
        if (match) {
          b.behind = Number(match[1]);
          b.ahead = Number(match[2]);
        }
      } catch {
        // Default branch missing or unreachable — leave ahead/behind null.
      }
    }),
  );

  return branches;
}

export interface ListCommitsOptions {
  ref?: string;
  path?: string | null;
  limit?: number;
  skip?: number;
}

export async function listCommits(
  project: GitBackedProject,
  options: ListCommitsOptions = {},
): Promise<{ commits: GitLogEntry[]; hasMore: boolean }> {
  const repoPath = await refreshMirror(project);
  const ref = validateRef(options.ref || project.defaultBranch);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const skip = Math.max(options.skip ?? 0, 0);
  const treePath = normalizeTreePath(options.path ?? null);

  const args = [
    'log',
    ref,
    `--pretty=format:${LOG_FORMAT}`,
    `-n`, String(limit + 1),
    `--skip`, String(skip),
  ];
  if (treePath) {
    args.push('--follow', '--', treePath);
  }

  const result = await runGit(args, repoPath, false);
  const entries = parseLogStdout(result.stdout);
  const hasMore = entries.length > limit;
  return {
    commits: hasMore ? entries.slice(0, limit) : entries,
    hasMore,
  };
}

export async function getCommit(
  project: GitBackedProject,
  sha: string,
): Promise<GitCommitDetail | null> {
  const repoPath = await refreshMirror(project);
  validateSha(sha);

  const log = await runGit(
    ['log', `--pretty=format:${LOG_FORMAT}`, '-n', '1', sha],
    repoPath,
    false,
  );
  const entries = parseLogStdout(log.stdout);
  if (entries.length === 0) return null;
  const entry = entries[0];

  // diff-tree gives us the file change list for a single commit; -m makes
  // merge commits emit per-parent diffs (we just take the first parent for
  // listing).
  const [nameStatus, numstat] = await Promise.all([
    runGit(
      ['diff-tree', '-r', '--no-commit-id', '--name-status', '-z', '--root', '-M', sha],
      repoPath,
      false,
    ).catch(() => ({ stdout: '', stderr: '' })),
    runGit(
      ['diff-tree', '-r', '--no-commit-id', '--numstat', '--root', '-M', sha],
      repoPath,
      false,
    ).catch(() => ({ stdout: '', stderr: '' })),
  ]);

  // name-status is NUL-separated; rename/copy entries take two extra NULs.
  const files = new Map<string, GitCommitFile>();
  const tokens = nameStatus.stdout.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const code = tokens[i];
    if (!code) continue;
    if (code.startsWith('R') || code.startsWith('C')) {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      if (!oldPath || !newPath) break;
      files.set(newPath, {
        path: newPath,
        old_path: oldPath,
        status: decodeStatusChar(code),
        additions: 0,
        deletions: 0,
      });
      i += 2;
    } else {
      const path = tokens[i + 1];
      if (!path) break;
      files.set(path, {
        path,
        old_path: null,
        status: decodeStatusChar(code),
        additions: 0,
        deletions: 0,
      });
      i += 1;
    }
  }

  for (const line of numstat.stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [addStr, delStr, rawPath] = parts;
    // For renamed entries numstat emits `old{ => new}` syntax; we'll match
    // by the destination if present, else fall back to the raw path.
    const destMatch = rawPath.match(/\{[^}]*=>\s*([^}]+)\}/);
    const path = destMatch
      ? rawPath.replace(/\{[^}]*=>\s*([^}]+)\}/, '$1')
      : rawPath;
    const existing = files.get(path);
    if (existing) {
      existing.additions = addStr === '-' ? 0 : Number(addStr) || 0;
      existing.deletions = delStr === '-' ? 0 : Number(delStr) || 0;
    }
  }

  return { ...entry, files: Array.from(files.values()) };
}

export interface GetCommitDiffOptions {
  /** When set, only emit the diff for this single path. */
  path?: string | null;
}

export interface CommitDiff {
  hash: string;
  parent: string | null;
  patch: string;
}

export async function getCommitDiff(
  project: GitBackedProject,
  sha: string,
  options: GetCommitDiffOptions = {},
): Promise<CommitDiff> {
  const repoPath = await refreshMirror(project);
  validateSha(sha);

  const args = ['diff-tree', '-p', '--root', '-M', '--no-color', sha];
  const treePath = normalizeTreePath(options.path ?? null);
  if (treePath) args.push('--', treePath);

  const result = await runGit(args, repoPath, false);

  let parent: string | null = null;
  try {
    const parentRes = await runGit(
      ['rev-list', '--parents', '-n', '1', sha],
      repoPath,
      false,
    );
    const parts = parentRes.stdout.trim().split(/\s+/);
    if (parts.length >= 2) parent = parts[1];
  } catch {
    parent = null;
  }

  return { hash: sha, parent, patch: result.stdout };
}

export interface GetFileHistoryOptions {
  ref?: string;
  limit?: number;
  skip?: number;
}

export async function getFileHistory(
  project: GitBackedProject,
  filePath: string,
  options: GetFileHistoryOptions = {},
): Promise<{ commits: GitLogEntry[]; hasMore: boolean }> {
  const normalized = normalizeTreePath(filePath);
  if (!normalized) throw new Error('File path is required');
  return listCommits(project, {
    ref: options.ref,
    path: normalized,
    limit: options.limit,
    skip: options.skip,
  });
}

export interface GetFileAtRefResult {
  content: string;
  found: boolean;
}

export async function getFileAtRef(
  project: GitBackedProject,
  filePath: string,
  ref: string,
): Promise<GetFileAtRefResult> {
  const normalized = normalizeTreePath(filePath);
  if (!normalized) return { content: '', found: false };
  validateRef(ref);
  const repoPath = await refreshMirror(project);
  try {
    const result = await runGit(['show', `${ref}:${normalized}`], repoPath, false);
    return { content: result.stdout, found: true };
  } catch {
    return { content: '', found: false };
  }
}

// ─── Branch diffing & merging (powers the change-request layer) ─────────────

export interface BranchDiffSummary {
  files: GitCommitFile[];
  files_changed: number;
  additions: number;
  deletions: number;
  patch: string;
  base_sha: string;
  head_sha: string;
  merge_base: string | null;
}

export interface MergePreview {
  base_sha: string;
  head_sha: string;
  merge_base: string | null;
  can_fast_forward: boolean;
  can_merge: boolean;
  conflicts: string[];
  is_up_to_date: boolean;
}

export interface MergeOptions {
  authorName?: string;
  authorEmail?: string;
  message?: string;
}

export interface MergeResult {
  merge_commit_sha: string;
  fast_forward: boolean;
  base_sha_before: string;
  base_sha_after: string;
}

/** Resolves a branch name to its tip commit SHA (full 40-char hex). */
export async function resolveBranchTip(
  project: GitBackedProject,
  ref: string,
): Promise<string> {
  validateRef(ref);
  const repoPath = await refreshMirror(project);
  const result = await runGit(['rev-parse', `refs/heads/${ref}`], repoPath, false);
  return result.stdout.trim();
}

/** Returns the merge-base SHA between two branches, or null if there is none. */
export async function getMergeBase(
  project: GitBackedProject,
  baseRef: string,
  headRef: string,
): Promise<string | null> {
  validateRef(baseRef);
  validateRef(headRef);
  const repoPath = await refreshMirror(project);
  try {
    const result = await runGit(
      ['merge-base', `refs/heads/${baseRef}`, `refs/heads/${headRef}`],
      repoPath,
      false,
    );
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function computeDiffByRange(
  project: GitBackedProject,
  baseRevish: string,
  headRevish: string,
): Promise<BranchDiffSummary> {
  const repoPath = await refreshMirror(project, true);

  // Resolve the input revs so we can also surface the SHAs and merge base.
  // For branch names we still hit refs/heads/<name> to disambiguate from any
  // accidentally same-named tag.
  const [baseSha, headSha, mergeBase] = await Promise.all([
    runGit(['rev-parse', baseRevish], repoPath, false).then((r) => r.stdout.trim()),
    runGit(['rev-parse', headRevish], repoPath, false).then((r) => r.stdout.trim()),
    runGit(['merge-base', baseRevish, headRevish], repoPath, false)
      .then((r) => r.stdout.trim() || null)
      .catch(() => null),
  ]);

  const range = `${baseRevish}...${headRevish}`;

  const [nameStatus, numstat, patch] = await Promise.all([
    runGit(['diff', '--name-status', '-z', '-M', range], repoPath, false).catch(() => ({ stdout: '', stderr: '' })),
    runGit(['diff', '--numstat', '-M', range], repoPath, false).catch(() => ({ stdout: '', stderr: '' })),
    runGit(['diff', '--no-color', '-M', range], repoPath, false).catch(() => ({ stdout: '', stderr: '' })),
  ]);

  const files = new Map<string, GitCommitFile>();
  const tokens = nameStatus.stdout.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const code = tokens[i];
    if (!code) continue;
    if (code.startsWith('R') || code.startsWith('C')) {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      if (!oldPath || !newPath) break;
      files.set(newPath, {
        path: newPath,
        old_path: oldPath,
        status: decodeStatusChar(code),
        additions: 0,
        deletions: 0,
      });
      i += 2;
    } else {
      const path = tokens[i + 1];
      if (!path) break;
      files.set(path, {
        path,
        old_path: null,
        status: decodeStatusChar(code),
        additions: 0,
        deletions: 0,
      });
      i += 1;
    }
  }

  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const line of numstat.stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [addStr, delStr, rawPath] = parts;
    const destMatch = rawPath.match(/\{[^}]*=>\s*([^}]+)\}/);
    const path = destMatch
      ? rawPath.replace(/\{[^}]*=>\s*([^}]+)\}/, '$1')
      : rawPath;
    const additions = addStr === '-' ? 0 : Number(addStr) || 0;
    const deletions = delStr === '-' ? 0 : Number(delStr) || 0;
    totalAdditions += additions;
    totalDeletions += deletions;
    const existing = files.get(path);
    if (existing) {
      existing.additions = additions;
      existing.deletions = deletions;
    }
  }

  const fileList = Array.from(files.values());
  return {
    files: fileList,
    files_changed: fileList.length,
    additions: totalAdditions,
    deletions: totalDeletions,
    patch: patch.stdout,
    base_sha: baseSha,
    head_sha: headSha,
    merge_base: mergeBase,
  };
}

/**
 * Full diff of `headRef` against `baseRef`. Uses a three-dot range
 * (`base...head`) so commits on base that aren't on head don't show up — this
 * matches GitHub PR semantics.
 */
export async function getBranchDiff(
  project: GitBackedProject,
  baseRef: string,
  headRef: string,
): Promise<BranchDiffSummary> {
  validateRef(baseRef);
  validateRef(headRef);
  return computeDiffByRange(project, `refs/heads/${baseRef}`, `refs/heads/${headRef}`);
}

/**
 * Diff between two arbitrary SHAs (or any commit-ish revs). Used for showing
 * the "what was merged" diff on a CR whose head branch has already been merged
 * into base — at that point `base...head` is empty, but the snapshot SHAs
 * captured at merge time still resolve.
 */
export async function getDiffBetweenShas(
  project: GitBackedProject,
  baseSha: string,
  headSha: string,
): Promise<BranchDiffSummary> {
  validateSha(baseSha);
  validateSha(headSha);
  return computeDiffByRange(project, baseSha, headSha);
}

/**
 * Predict whether `headRef` can merge cleanly into `baseRef` without touching
 * either branch. Uses `git merge-tree --write-tree` (git 2.38+) which performs
 * a server-side 3-way merge entirely in the object DB. Non-zero exit means
 * conflicts; the conflicting paths are returned for the UI to render.
 */
export async function previewMerge(
  project: GitBackedProject,
  baseRef: string,
  headRef: string,
): Promise<MergePreview> {
  validateRef(baseRef);
  validateRef(headRef);
  const repoPath = await refreshMirror(project, true);

  const [baseSha, headSha, mergeBase] = await Promise.all([
    resolveBranchTip(project, baseRef),
    resolveBranchTip(project, headRef),
    getMergeBase(project, baseRef, headRef),
  ]);

  const isUpToDate = baseSha === headSha;
  const canFastForward = mergeBase === baseSha && !isUpToDate;

  const result = await runGitCapture(
    ['merge-tree', '--write-tree', '--name-only', `refs/heads/${baseRef}`, `refs/heads/${headRef}`],
    repoPath,
    project.gitAuthToken,
  );

  const conflicts: string[] = [];
  let canMerge = true;
  if (result.exitCode !== 0) {
    canMerge = false;
    // merge-tree --name-only output on conflict:
    //   <tree-sha>
    //   <conflict path 1>
    //   <conflict path 2>
    //   <blank line>
    //   Auto-merging <path>
    //   CONFLICT (content): Merge conflict in <path>
    // The conflict paths sit between the tree SHA and the first blank line.
    const lines = result.stdout.split('\n');
    let started = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (!started) {
        if (/^[0-9a-f]{40}$/.test(line)) started = true;
        continue;
      }
      if (!line) break;
      if (line.startsWith('Auto-merging ') || line.startsWith('CONFLICT ')) break;
      conflicts.push(line);
    }
  }

  return {
    base_sha: baseSha,
    head_sha: headSha,
    merge_base: mergeBase,
    can_fast_forward: canFastForward,
    can_merge: canMerge && !isUpToDate,
    conflicts,
    is_up_to_date: isUpToDate,
  };
}

/**
 * Merge `headRef` into `baseRef` and push the result. Fast-forwards when the
 * topology allows it; otherwise creates a 3-way merge commit using
 * `git merge-tree --write-tree` + `git commit-tree` (no working tree required,
 * works against a bare mirror).
 *
 * Throws if there are conflicts; callers should call `previewMerge` first to
 * surface the conflict list in the UI.
 */
export async function mergeBranches(
  project: GitBackedProject,
  baseRef: string,
  headRef: string,
  options: MergeOptions = {},
): Promise<MergeResult> {
  validateRef(baseRef);
  validateRef(headRef);
  if (baseRef === headRef) throw new Error('Refusing to merge a branch into itself');

  const repoPath = await refreshMirror(project, true);

  const [baseShaBefore, headSha, mergeBase] = await Promise.all([
    resolveBranchTip(project, baseRef),
    resolveBranchTip(project, headRef),
    getMergeBase(project, baseRef, headRef),
  ]);

  if (baseShaBefore === headSha) {
    throw new Error('Branches already point at the same commit');
  }

  // Fast-forward: just advance base to head and push.
  if (mergeBase === baseShaBefore) {
    await runGit(
      ['update-ref', `refs/heads/${baseRef}`, headSha, baseShaBefore],
      repoPath,
      false,
    );
    await runGit(
      ['push', 'origin', `${headSha}:refs/heads/${baseRef}`],
      repoPath,
      true,
      project.gitAuthToken,
      undefined,
      hostFromRepoUrl(project.repoUrl),
    );
    return {
      merge_commit_sha: headSha,
      fast_forward: true,
      base_sha_before: baseShaBefore,
      base_sha_after: headSha,
    };
  }

  // 3-way merge.
  const mergeTreeResult = await runGitCapture(
    ['merge-tree', '--write-tree', `refs/heads/${baseRef}`, `refs/heads/${headRef}`],
    repoPath,
    project.gitAuthToken,
  );
  if (mergeTreeResult.exitCode !== 0) {
    throw new Error('Merge conflicts detected — resolve before merging');
  }
  const treeSha = mergeTreeResult.stdout.split('\n')[0]?.trim();
  if (!treeSha || !/^[0-9a-f]{40}$/.test(treeSha)) {
    throw new Error('merge-tree did not return a valid tree SHA');
  }

  const message = options.message || `Merge branch '${headRef}' into '${baseRef}'`;
  const authorName = options.authorName || 'Kortix';
  const authorEmail = options.authorEmail || 'noreply@kortix.ai';

  const commitResult = await runGit(
    ['commit-tree', treeSha, '-p', baseShaBefore, '-p', headSha, '-m', message],
    repoPath,
    false,
    null,
    {
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_COMMITTER_NAME: authorName,
      GIT_COMMITTER_EMAIL: authorEmail,
    },
  );
  const mergeCommitSha = commitResult.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(mergeCommitSha)) {
    throw new Error('commit-tree did not return a valid commit SHA');
  }

  await runGit(
    ['update-ref', `refs/heads/${baseRef}`, mergeCommitSha, baseShaBefore],
    repoPath,
    false,
  );
  await runGit(
    ['push', 'origin', `${mergeCommitSha}:refs/heads/${baseRef}`],
    repoPath,
    true,
    project.gitAuthToken,
    undefined,
    hostFromRepoUrl(project.repoUrl),
  );

  return {
    merge_commit_sha: mergeCommitSha,
    fast_forward: false,
    base_sha_before: baseShaBefore,
    base_sha_after: mergeCommitSha,
  };
}
