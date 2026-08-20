// Branch listing + mutating ops (create/delete session branch, single-file
// commit-and-push). These write to the remote, so they own the auth-host +
// fresh-fetch dance.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mapLimit } from '@kortix/registry';
import { validateRef } from '../git-ref';
import { createBranchRef, getBranchCommitSha, parseGitHubRepoUrl } from '../github';
import { isMissingRemoteBranchError } from '../managed-repo-seed';
import { FIELD_SEP } from './commits';
import {
  existingProjectMirrorPath,
  hostFromRepoUrl,
  invalidateProjectMirror,
  isGitOperationError,
  makeSessionBranchRepo,
  normalizeTreePath,
  refreshMirror,
  runGit,
  runGitCapture,
} from './mirror';
import type { GitBackedProject, GitBranchInfo } from './types';

// Bounded concurrency for blob hashing below — enough to cut many-file
// install wall-clock time without spawning an unbounded pile of `git
// hash-object` subprocesses per commit.
const HASH_CONCURRENCY = 8;
const BRANCH_COMPARE_CONCURRENCY = 8;
const BRANCH_COMPARE_LIMIT = 100;
const BRANCH_LIST_TIMEOUT_MS = 15_000;

export interface ExpectedFileRevision {
  path: string;
  sha: string | null;
  /** Logical file candidates in winner-priority order. */
  candidatePaths?: readonly string[];
}

export class GitFileRevisionConflictError extends Error {
  constructor(readonly path: string) {
    super(`File "${path}" changed since it was read`);
    this.name = 'GitFileRevisionConflictError';
  }
}

export function isExpectedFileRevisionRace(error: unknown): boolean {
  if (!isGitOperationError(error)) return false;
  const details = `${error.message}\n${error.stderr}`;
  if (error.gitArgs[0] === 'update-ref') {
    return details.includes(' but expected ') || details.includes('reference already exists');
  }
  return (
    details.includes('[rejected]') ||
    details.includes('non-fast-forward') ||
    details.includes('fetch first') ||
    details.includes('stale info') ||
    (error.gitArgs[0] === 'push' && details.includes('failed to update ref'))
  );
}

async function readRemoteBranchTip(
  project: GitBackedProject,
  repoPath: string,
  branch: string,
  authHost: string,
): Promise<string | null | undefined> {
  const remote = await runGitCapture(
    ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
    repoPath,
    project.gitAuthToken,
    undefined,
    authHost,
    project.gitAuthHeaders,
  );
  if (remote.exitCode !== 0) return undefined;
  const sha = remote.stdout.trim().split(/\s+/, 1)[0] ?? '';
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * Hash every file's content into a git blob object (`git hash-object -w`),
 * with bounded concurrency — this used to be one subprocess at a time, which
 * dominated wall-clock time for many-file marketplace installs. Each file
 * gets its own uniquely-named temp file so concurrent writes never collide,
 * and the returned array preserves input order regardless of completion
 * order (downstream index construction must stay deterministic).
 */
export async function hashBlobs(
  files: Array<{ path: string; content: string }>,
  tempDir: string,
  repoPath: string,
): Promise<Array<{ path: string; sha: string }>> {
  return mapLimit(
    files.map((file, i) => ({ file, i })),
    HASH_CONCURRENCY,
    async ({ file, i }) => {
      const blobFile = join(tempDir, `blob-${i}`);
      await writeFile(blobFile, file.content, { flag: 'wx' });
      const sha = (await runGit(['hash-object', '-w', blobFile], repoPath, false)).stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('git hash-object did not return a blob SHA');
      return { path: file.path, sha };
    },
  );
}

function branchFromRemoteRef(name: string, tip: string, defaultBranch: string): GitBranchInfo {
  const isDefault = name === defaultBranch;
  return {
    name,
    is_default: isDefault,
    tip,
    tip_short: tip.slice(0, 7),
    subject: '',
    committer_name: '',
    committer_email: '',
    committed_at: '',
    ahead: isDefault ? 0 : null,
    behind: isDefault ? 0 : null,
  };
}

export function parseRemoteBranches(stdout: string, defaultBranch: string): GitBranchInfo[] {
  const branches = stdout
    .split('\n')
    .map((line) => line.trim().match(/^([0-9a-f]{40})\s+refs\/heads\/(.+)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => branchFromRemoteRef(match[2] ?? '', match[1] ?? '', defaultBranch));

  branches.sort((a, b) => {
    if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return branches;
}

async function readCachedBranchMetadata(
  repoPath: string,
  baseRef: string,
): Promise<Map<string, GitBranchInfo>> {
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
        committer_email: committerEmail.replace(/^</, '').replace(/>$/, ''),
        committed_at: committedAt,
        ahead: null,
        behind: null,
      };
    })
    .filter((b): b is GitBranchInfo => b !== null);

  // Exact ahead/behind requires one revision walk per branch on the Git
  // versions available in our runtime. Bound both process concurrency and the
  // total comparison count. A repository with thousands of session branches
  // must never spawn thousands of child processes from one HTTP request.
  const comparable =
    branches.length <= BRANCH_COMPARE_LIMIT
      ? branches
      : branches.filter((branch) => branch.is_default);
  await mapLimit(comparable, BRANCH_COMPARE_CONCURRENCY, async (b) => {
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
  });

  return new Map(branches.map((branch) => [branch.name, branch]));
}

/**
 * List the remote branch refs without cloning repository history.
 *
 * The old path called `refreshMirror()` first. A cold request cloned the full
 * repository and then started one `git rev-list` process per branch. That
 * cannot fit inside the API or SDK deadline for repositories with thousands
 * of branches. One `git ls-remote --heads` call returns the authoritative refs
 * without transferring commit history. A valid warm mirror may enrich the
 * response with commit metadata, but this read never creates or refreshes it.
 */
export async function listBranches(project: GitBackedProject): Promise<GitBranchInfo[]> {
  const result = await runGit(
    ['ls-remote', '--heads', project.repoUrl],
    undefined,
    true,
    project.gitAuthToken,
    undefined,
    hostFromRepoUrl(project.repoUrl),
    BRANCH_LIST_TIMEOUT_MS,
    project.gitAuthHeaders,
  );
  const branches = parseRemoteBranches(result.stdout, project.defaultBranch);
  const repoPath = existingProjectMirrorPath(project);
  if (!repoPath || branches.length === 0) return branches;

  const cached = await readCachedBranchMetadata(repoPath, project.defaultBranch).catch(() => null);
  if (!cached) return branches;

  return branches.map((branch) => {
    const metadata = cached.get(branch.name);
    // Only reuse metadata for the same remote tip. A stale mirror must not
    // attach the previous commit's subject, date, or comparison counts.
    return metadata?.tip === branch.tip ? metadata : branch;
  });
}

/**
 * Does `refs/heads/<branch>` exist on the REMOTE right now?
 *
 * One `git ls-remote` round trip against the upstream — no clone, no shared
 * mirror, no cache. That matters for both callers: provisioning must PROVE a
 * scaffold seed produced the default branch before it reports the project
 * active, and session start must decide whether the repo needs a repair seed.
 * `listBranches` cannot answer either question — it reads the cached bare
 * mirror, which happily returns an empty list for a repo with no refs.
 *
 * The ref is validated before it reaches argv, so a branch name can never be
 * smuggled in as a `git ls-remote` option (`--upload-pack=…`).
 */
export async function remoteBranchExists(
  project: GitBackedProject,
  branch: string,
): Promise<boolean> {
  return (await resolveRemoteBranchTip(project, branch)) !== null;
}

export async function resolveRemoteBranchTip(
  project: GitBackedProject,
  branch: string,
): Promise<string | null> {
  const ref = validateRef(branch);
  const result = await runGit(
    ['ls-remote', '--heads', project.repoUrl, `refs/heads/${ref}`],
    undefined,
    true,
    project.gitAuthToken,
    undefined,
    hostFromRepoUrl(project.repoUrl),
    undefined,
    project.gitAuthHeaders,
  );
  const [sha, remoteRef] = result.stdout.trim().split(/\s+/);
  return /^[0-9a-f]{40}$/.test(sha) && remoteRef === `refs/heads/${ref}` ? sha : null;
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
    const fetchBase = () =>
      runGit(
        ['fetch', '--no-tags', '--depth=1', 'origin', `+refs/heads/${base}:refs/heads/${base}`],
        repoPath,
        true,
        project.gitAuthToken,
        undefined,
        authHost,
        undefined,
        project.gitAuthHeaders,
      );
    try {
      await fetchBase();
    } catch (error) {
      // `couldn't find remote ref refs/heads/<base>` on a MANAGED repo means the
      // scaffold seed never landed — the repo is structurally empty and every
      // surface built on it (files, agents, skills, manifest version, session
      // start) is dead. Seed it on demand, then retry once. Reactive by design:
      // the happy path pays nothing, and a repair only runs for the exact
      // failure it can fix (see isMissingRemoteBranchError).
      if (!isMissingRemoteBranchError(error)) throw error;
      const { ensureManagedRepoSeeded } = await import('../managed-repo-seed');
      const outcome = await ensureManagedRepoSeeded(project.projectId, 'session-branch');
      if (!outcome.repaired) throw error;
      await fetchBase();
    }
    await runGit(
      ['push', 'origin', `refs/heads/${base}:refs/heads/${branch}`],
      repoPath,
      true,
      project.gitAuthToken,
      undefined,
      authHost,
      undefined,
      project.gitAuthHeaders,
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
  const remote = await runGit(
    ['ls-remote', '--heads', 'origin', branchName],
    repoPath,
    true,
    project.gitAuthToken,
    undefined,
    authHost,
    undefined,
    project.gitAuthHeaders,
  ).catch(() => ({ stdout: '', stderr: '' }));
  if (!remote.stdout.trim()) return false;

  await runGit(
    ['push', 'origin', `:${branchName}`],
    repoPath,
    true,
    project.gitAuthToken,
    undefined,
    authHost,
    undefined,
    project.gitAuthHeaders,
  );
  await runGit(['update-ref', '-d', `refs/heads/${branchName}`], repoPath, false).catch(
    () => undefined,
  );
  return true;
}

/**
 * Commit one file onto `branch` and push — a thin delegate over
 * {@link commitMultipleFilesToBranch} (the single commit path).
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
    expectedFileRevision?: ExpectedFileRevision;
  },
): Promise<{ commitSha: string }> {
  if (!normalizeTreePath(opts.path)) throw new Error('File path is required');
  const { commitSha } = await commitMultipleFilesToBranch(project, {
    files: [{ path: opts.path, content: opts.content }],
    message: opts.message,
    branch: opts.branch,
    authorName: opts.authorName,
    authorEmail: opts.authorEmail,
    expectedFileRevision: opts.expectedFileRevision,
  });
  return { commitSha };
}

/**
 * Commit a set of file writes (+ optional deletions) in ONE commit and push —
 * provider-agnostic (GitHub, GitLab, any HTTPS git remote), unlike the GitHub
 * Contents-API path. Git plumbing in the bare mirror: hash each new blob, splice
 * writes/removals into the branch tip's tree through a throwaway index,
 * `commit-tree` once, then push (creating the branch from an empty tree if it
 * doesn't exist). Used anywhere multiple files need one atomic commit — e.g.
 * an agent-driven marketplace import's change request.
 */
export async function commitMultipleFilesToBranch(
  project: GitBackedProject,
  opts: {
    files?: Array<{ path: string; content: string }>;
    /** Repo-relative paths to remove from the tree in the same commit. */
    deletes?: string[];
    message: string;
    branch?: string;
    authorName?: string;
    authorEmail?: string;
    expectedFileRevision?: ExpectedFileRevision;
  },
): Promise<{ commitSha: string; branch: string; fileCount: number }> {
  const files = (opts.files ?? [])
    .map((f) => ({ path: normalizeTreePath(f.path), content: f.content }))
    .filter((f): f is { path: string; content: string } => Boolean(f.path));
  const deletes = (opts.deletes ?? [])
    .map((p) => normalizeTreePath(p))
    .filter((p): p is string => Boolean(p));
  if (files.length === 0 && deletes.length === 0) throw new Error('Nothing to commit');
  const branch = validateRef(opts.branch || project.defaultBranch);
  const authHost = hostFromRepoUrl(project.repoUrl);
  const repoPath = await refreshMirror(project, true);

  const tip = await runGitCapture(['rev-parse', '--verify', `refs/heads/${branch}`], repoPath);
  const parentSha = tip.exitCode === 0 ? tip.stdout.trim() : null;
  const expectedPath = opts.expectedFileRevision
    ? normalizeTreePath(opts.expectedFileRevision.path)
    : undefined;
  if (opts.expectedFileRevision && !expectedPath) {
    throw new Error('Expected file revision path is required');
  }
  const expectedFileRevision =
    opts.expectedFileRevision && expectedPath
      ? {
          path: expectedPath,
          sha: opts.expectedFileRevision.sha,
          candidatePaths: Array.from(
            new Set(
              (opts.expectedFileRevision.candidatePaths ?? [expectedPath])
                .map((path) => normalizeTreePath(path))
                .filter((path): path is string => Boolean(path)),
            ),
          ),
        }
      : undefined;
  if (expectedFileRevision) {
    if (!expectedFileRevision.candidatePaths.includes(expectedFileRevision.path)) {
      expectedFileRevision.candidatePaths.push(expectedFileRevision.path);
    }
    const current = parentSha
      ? await runGitCapture(
          ['ls-tree', parentSha, '--', ...expectedFileRevision.candidatePaths],
          repoPath,
        )
      : { stdout: '', stderr: '', exitCode: 0 };
    if (current.exitCode !== 0) {
      throw new Error(`Failed to read current revision for "${expectedFileRevision.path}"`);
    }
    const revisions = new Map<string, string>();
    for (const line of current.stdout.split('\n')) {
      const match = line.match(/^\d+\s+blob\s+([0-9a-f]{40})\t(.+)$/);
      if (match?.[1] && match[2]) revisions.set(match[2], match[1]);
    }
    const currentWinner =
      expectedFileRevision.candidatePaths.find((path) => revisions.has(path)) ?? null;
    const expectedWinner = expectedFileRevision.sha === null ? null : expectedFileRevision.path;
    const currentSha = revisions.get(expectedFileRevision.path) ?? null;
    if (currentWinner !== expectedWinner || currentSha !== expectedFileRevision.sha) {
      throw new GitFileRevisionConflictError(expectedFileRevision.path);
    }
  }

  const author = opts.authorName || 'Kortix';
  const email = opts.authorEmail || 'noreply@kortix.ai';
  const identEnv = {
    GIT_AUTHOR_NAME: author,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: author,
    GIT_COMMITTER_EMAIL: email,
  };

  const tempDir = await mkdtemp(join(repoPath, '.kortix-tmp-'));
  const indexFile = join(tempDir, 'index');
  const indexEnv = { GIT_INDEX_FILE: indexFile };

  try {
    // Hash every blob into the object store first (bounded concurrency —
    // see hashBlobs above). Everything from here on stays sequential: it all
    // shares the one throwaway index file.
    const blobs = await hashBlobs(files, tempDir, repoPath);

    // Seed the throwaway index from the parent tree (or empty), splice all files.
    if (parentSha) await runGit(['read-tree', parentSha], repoPath, false, null, indexEnv);
    else await runGit(['read-tree', '--empty'], repoPath, false, null, indexEnv);
    for (const b of blobs) {
      await runGit(
        ['update-index', '--add', '--cacheinfo', `100644,${b.sha},${b.path}`],
        repoPath,
        false,
        null,
        indexEnv,
      );
    }
    // Deleting from the index needs a work tree defined (the mirror is bare, so
    // `--force-remove` otherwise errors "must be run in a work tree"). Point
    // GIT_WORK_TREE at the empty temp dir — the path is absent there, so it's
    // removed from the index. (`--add --cacheinfo` above needs no work tree.)
    const deleteEnv = deletes.length ? { ...indexEnv, GIT_WORK_TREE: tempDir } : indexEnv;
    for (const path of deletes) {
      await runGit(['update-index', '--force-remove', path], repoPath, false, null, deleteEnv);
    }
    const treeSha = (await runGit(['write-tree'], repoPath, false, null, indexEnv)).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(treeSha))
      throw new Error('git write-tree did not return a tree SHA');

    const commitArgs = ['commit-tree', treeSha];
    if (parentSha) commitArgs.push('-p', parentSha);
    commitArgs.push('-m', opts.message);
    const commitSha = (await runGit(commitArgs, repoPath, false, null, identEnv)).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(commitSha))
      throw new Error('git commit-tree did not return a commit SHA');

    try {
      const pushArgs = ['push'];
      if (expectedFileRevision) {
        pushArgs.push(`--force-with-lease=refs/heads/${branch}:${parentSha ?? ''}`);
      }
      pushArgs.push('origin', `${commitSha}:refs/heads/${branch}`);
      await runGit(
        pushArgs,
        repoPath,
        true,
        project.gitAuthToken,
        undefined,
        authHost,
        undefined,
        project.gitAuthHeaders,
      );
    } catch (error) {
      invalidateProjectMirror(project.projectId);
      if (expectedFileRevision) {
        const remoteTip = await readRemoteBranchTip(project, repoPath, branch, authHost);
        if (remoteTip === commitSha) {
          return { commitSha, branch, fileCount: files.length };
        }
        if (remoteTip !== undefined && remoteTip !== parentSha) {
          throw new GitFileRevisionConflictError(expectedFileRevision.path);
        }
        if (isExpectedFileRevisionRace(error)) {
          throw new GitFileRevisionConflictError(expectedFileRevision.path);
        }
      }
      throw error;
    }

    invalidateProjectMirror(project.projectId);
    return { commitSha, branch, fileCount: files.length };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
