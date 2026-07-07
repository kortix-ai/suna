// Branch listing + mutating ops (create/delete session branch, single-file
// commit-and-push). These write to the remote, so they own the auth-host +
// fresh-fetch dance.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mapLimit } from '@kortix/registry';
import { createBranchRef, getBranchCommitSha, parseGitHubRepoUrl } from '../github';
import { validateRef } from '../git-ref';
import {
  hostFromRepoUrl,
  invalidateProjectMirror,
  makeSessionBranchRepo,
  normalizeTreePath,
  refreshMirror,
  runGit,
  runGitCapture,
} from './mirror';
import { FIELD_SEP } from './commits';
import type { GitBackedProject, GitBranchInfo } from './types';

// Bounded concurrency for blob hashing below — enough to cut many-file
// install wall-clock time without spawning an unbounded pile of `git
// hash-object` subprocesses per commit.
const HASH_CONCURRENCY = 8;

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
  },
): Promise<{ commitSha: string }> {
  if (!normalizeTreePath(opts.path)) throw new Error('File path is required');
  const { commitSha } = await commitMultipleFilesToBranch(project, {
    files: [{ path: opts.path, content: opts.content }],
    message: opts.message,
    branch: opts.branch,
    authorName: opts.authorName,
    authorEmail: opts.authorEmail,
  });
  return { commitSha };
}

/**
 * Commit a set of file writes (+ optional deletions) in ONE commit and push —
 * provider-agnostic (GitHub, GitLab, any HTTPS git remote), unlike the GitHub
 * Contents-API path. Git plumbing in the bare mirror: hash each new blob, splice
 * writes/removals into the branch tip's tree through a throwaway index,
 * `commit-tree` once, then push (creating the branch from an empty tree if it
 * doesn't exist). The marketplace install/uninstall paths commit an item's files
 * + the updated registry-lock.json atomically.
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
  },
): Promise<{ commitSha: string; branch: string; fileCount: number }> {
  const files = (opts.files ?? [])
    .map((f) => ({ path: normalizeTreePath(f.path), content: f.content }))
    .filter((f): f is { path: string; content: string } => Boolean(f.path));
  const deletes = (opts.deletes ?? []).map((p) => normalizeTreePath(p)).filter((p): p is string => Boolean(p));
  if (files.length === 0 && deletes.length === 0) throw new Error('Nothing to commit');
  const branch = validateRef(opts.branch || project.defaultBranch);
  const authHost = hostFromRepoUrl(project.repoUrl);
  const repoPath = await refreshMirror(project, true);

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
    if (!/^[0-9a-f]{40}$/.test(treeSha)) throw new Error('git write-tree did not return a tree SHA');

    const commitArgs = ['commit-tree', treeSha];
    if (parentSha) commitArgs.push('-p', parentSha);
    commitArgs.push('-m', opts.message);
    const commitSha = (await runGit(commitArgs, repoPath, false, null, identEnv)).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error('git commit-tree did not return a commit SHA');

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
    return { commitSha, branch, fileCount: files.length };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
