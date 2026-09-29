// The commit writer for git-backed projects: hash blobs, splice them into the
// branch tip's tree through a throwaway index, `commit-tree`, then push —
// with the expected-revision conflict check and the push-race recovery.
// Extracted verbatim from ./branches, which re-exports the public symbols.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mapLimit } from '@kortix/registry';
import { validateRef } from '../git-ref';
import {
  hostFromRepoUrl,
  invalidateProjectMirror,
  isGitOperationError,
  isRemotePushPolicyRejection,
  normalizeTreePath,
  refreshMirror,
  retryTransientGitMirror,
  runGit,
  runGitCapture,
} from './mirror';
import type { GitBackedProject } from './types';

// Bounded concurrency for blob hashing below — enough to cut many-file
// install wall-clock time without spawning an unbounded pile of `git
// hash-object` subprocesses per commit.
const HASH_CONCURRENCY = 8;

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

/**
 * Throws GitFileRevisionConflictError when any expected blob no longer holds
 * the value the caller read at the parent tip.
 */
async function checkExpectedRevisions(
  repoPath: string,
  parentSha: string | null,
  expectedFileRevision: { path: string; sha: string | null; candidatePaths: string[] },
  opts: { alsoExpect?: Array<{ path: string; sha: string }> },
): Promise<void> {
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
  const alsoExpect = (opts.alsoExpect ?? [])
    .map((entry) => ({ path: normalizeTreePath(entry.path), sha: entry.sha }))
    .filter((entry): entry is { path: string; sha: string } => Boolean(entry.path));
  if (alsoExpect.length > 0) {
    const listed = parentSha
      ? await runGitCapture(
          ['ls-tree', parentSha, '--', ...alsoExpect.map((entry) => entry.path)],
          repoPath,
        )
      : { stdout: '', stderr: '', exitCode: 0 };
    if (listed.exitCode !== 0) {
      throw new Error(`Failed to read current revision for "${alsoExpect[0]?.path}"`);
    }
    const tipRevisions = new Map<string, string>();
    for (const line of listed.stdout.split('\n')) {
      const match = line.match(/^\d+\s+blob\s+([0-9a-f]{40})\t(.+)$/);
      if (match?.[1] && match[2]) tipRevisions.set(match[2], match[1]);
    }
    for (const entry of alsoExpect) {
      if (tipRevisions.get(entry.path) !== entry.sha) {
        throw new GitFileRevisionConflictError(entry.path);
      }
    }
  }
}

/**
 * Build the commit object in the bare mirror without touching any ref; the
 * caller pushes it (and owns the tempDir cleanup).
 */
async function buildCommit(
  repoPath: string,
  parentSha: string | null,
  files: Array<{ path: string; content: string }>,
  deletes: string[],
  opts: { message: string; authorName?: string; authorEmail?: string },
  tempDir: string,
): Promise<string> {
  const author = opts.authorName || 'Kortix';
  const email = opts.authorEmail || 'noreply@kortix.ai';
  const identEnv = {
    GIT_AUTHOR_NAME: author,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: author,
    GIT_COMMITTER_EMAIL: email,
  };

  const indexFile = join(tempDir, 'index');
  const indexEnv = { GIT_INDEX_FILE: indexFile };

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
  return commitSha;
}

/**
 * Push the built commit (with `--force-with-lease` when an expected revision
 * is pinned) and classify a failed push by reading the remote tip back. A
 * raced success returns WITHOUT the convergence trigger, like the pre-split
 * early return.
 */
async function pushCommit(
  project: GitBackedProject,
  repoPath: string,
  authHost: string,
  branch: string,
  commitSha: string,
  parentSha: string | null,
  expectedFileRevision: { path: string; sha: string | null; candidatePaths: string[] } | undefined,
  files: Array<{ path: string; content: string }>,
): Promise<{ commitSha: string; branch: string; fileCount: number }> {
  try {
    const pushArgs = ['push'];
    if (expectedFileRevision) {
      pushArgs.push(`--force-with-lease=refs/heads/${branch}:${parentSha ?? ''}`);
    }
    pushArgs.push('origin', `${commitSha}:refs/heads/${branch}`);
    // The push is the last network step of every API write to a branch. Like
    // the cold clone and the warm fetch, it can fail for a TRANSIENT upstream
    // reason — a socket blip, or GitHub's ambiguous `RPC failed; HTTP 404`
    // for a private repo whose App-installation credential is momentarily not
    // (yet) usable. Without a retry that one blip surfaced as a 502 to the
    // client and paged Sentry from the web app on a connector/manifest write
    // during onboarding (Better Stack FE pattern `0cb9ab43…`). Reuse the
    // clone/fetch retry: a transient failure retries; a permanent one (bad
    // ref, real auth denial, a lost `--force-with-lease` race) rethrows on the
    // first attempt and is classified by the catch below.
    await retryTransientGitMirror({
      run: () => authGitPush(pushArgs, repoPath, project),
    });
  } catch (error) {
    invalidateProjectMirror(project.projectId);
    // A remote-policy rejection is permanent and NOT a stale tip: the remote
    // refused the ref by rule, so refreshing and retrying cannot help. Check
    // it before the revision-race path below, which would otherwise mistake
    // it for a concurrent edit and hide the real cause behind a conflict.
    if (isRemotePushPolicyRejection(error)) throw error;
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
  // The branch moved. Sessions whose base ref is this branch converge on the
  // new config (spec, "Convergence triggers"). Every API write to a branch
  // goes through here. Dynamic import: `projects/lib` imports this module.
  void import('../lib/config-convergence-triggers')
    .then((triggers) => triggers.notifyBaseBranchMoved(project.projectId, branch, 'api-write'))
    .catch(() => {});
  return { commitSha, branch, fileCount: files.length };
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
    /**
     * More blobs that must be unchanged at the branch tip, checked together
     * with `expectedFileRevision` (which supplies the push lease, so it is
     * required when this is set). A manifest with `imports:` passes every
     * imported file: a concurrent edit to ANY of them can introduce a duplicate
     * name the merged document this commit was computed from never saw.
     */
    alsoExpect?: Array<{ path: string; sha: string }>;
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
    await checkExpectedRevisions(repoPath, parentSha, expectedFileRevision, opts);
  } else if (opts.alsoExpect?.length) {
    throw new Error('alsoExpect requires expectedFileRevision');
  }

  const tempDir = await mkdtemp(join(repoPath, '.kortix-tmp-'));
  try {
    const commitSha = await buildCommit(repoPath, parentSha, files, deletes, opts, tempDir);
    return await pushCommit(
      project,
      repoPath,
      authHost,
      branch,
      commitSha,
      parentSha,
      expectedFileRevision,
      files,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The authenticated `git push` incantation every remote write shares
 * (token/basic auth scoped to the repo's host, default timeout).
 */
export async function authGitPush(args: string[], repoPath: string, project: GitBackedProject) {
  return runGit(
    args,
    repoPath,
    true,
    project.gitAuthToken,
    undefined,
    hostFromRepoUrl(project.repoUrl),
    undefined,
    project.gitAuthHeaders,
  );
}
