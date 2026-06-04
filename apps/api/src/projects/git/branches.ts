// Branch listing + mutating ops (create/delete session branch, single-file
// commit-and-push). These write to the remote, so they own the auth-host +
// fresh-fetch dance.

import { createHash } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
 * Commit a single file's contents onto `branch` and push — provider-agnostic.
 * Works for GitHub, GitLab, or any HTTPS git remote,
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
