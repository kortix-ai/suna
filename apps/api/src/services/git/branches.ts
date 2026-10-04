// Branch listing + mutating ops (create/delete session branch). These write to
// the remote, so they own the auth-host + fresh-fetch dance. The commit writer
// lives in ./commit-writer and is re-exported below so import paths keep
// resolving.

import { rm } from 'node:fs/promises';
import { mapLimit } from '@kortix/registry';
import { validateRef } from './git-ref';
import { isUuid } from '../../lib/validate';
import { createBranchRef, getBranchCommitSha, parseGitHubRepoUrl } from '../github/github';
import { isMissingRemoteBranchError } from '../projects/managed-repo-seed';
import { FIELD_SEP } from './commits';
import { authGitPush } from './commit-writer';
import {
  existingProjectMirrorPath,
  hostFromRepoUrl,
  invalidateProjectMirror,
  makeSessionBranchRepo,
  refreshMirror,
  runGit,
} from './mirror';
import { recentBranchList } from './branch-list-cache';
import type { GitBackedProject, GitBranchInfo } from './types';

export {
  commitFileToBranch,
  commitMultipleFilesToBranch,
  hashBlobs,
  GitFileRevisionConflictError,
  isExpectedFileRevisionRace,
} from './commit-writer';
export type { ExpectedFileRevision } from './commit-writer';

const BRANCH_COMPARE_CONCURRENCY = 8;
const BRANCH_COMPARE_LIMIT = 100;
const BRANCH_LIST_TIMEOUT_MS = 15_000;

// A session branch's name IS the session id — createRemoteSessionBranch
// (../lib/sessions.ts) never prefixes it, and every session id is a
// validated UUID (isUuid, ../lib/sessions.ts) before a branch is ever cut
// from it. A project with a long history can carry thousands of these, and
// a human never picks one by name — every UI branch picker searches/limits
// on the human branches. Excluding them from the default response is what
// cut GET /:projectId/branches from ~977KB (thousands of session branches on
// a busy project) down to the human-authored set.
export function isSessionBranchName(name: string): boolean {
  return isUuid(name);
}

export const BRANCH_LIST_DEFAULT_LIMIT = 500;
export const BRANCH_LIST_MAX_LIMIT = 2000;

export interface BranchListFilter {
  /** Case-insensitive substring match on branch name. */
  q?: string;
  /** Capped at BRANCH_LIST_MAX_LIMIT regardless of what's requested. */
  limit?: number;
  /** `false` drops auto-created session branches (see isSessionBranchName
   *  above) — a default-branch picker never offers one. Absent means INCLUDE:
   *  the Files version selector and the change-request head picker list
   *  session branches on purpose, and older clients expect them. */
  includeSessionBranches?: boolean;
}

/**
 * Applies the response-shaping filters for GET /:projectId/branches. Kept as
 * a pure function, separate from the git subprocess call in `listBranches`
 * below, so the filtering rules are unit-testable without a repository.
 */
export function filterBranchesForResponse(
  branches: readonly GitBranchInfo[],
  filter: BranchListFilter = {},
): GitBranchInfo[] {
  const q = filter.q?.trim().toLowerCase();
  const limit = Math.min(
    Math.max(Math.floor(filter.limit ?? BRANCH_LIST_DEFAULT_LIMIT), 1),
    BRANCH_LIST_MAX_LIMIT,
  );
  const filtered = branches.filter((branch) => {
    if (filter.includeSessionBranches === false && !branch.is_default && isSessionBranchName(branch.name)) {
      return false;
    }
    if (q && !branch.name.toLowerCase().includes(q)) return false;
    return true;
  });
  const page = filtered.slice(0, limit);
  // The cap must never hide the default branch: every picker preselects it.
  const defaultBranch = filtered.find((branch) => branch.is_default);
  if (defaultBranch && !page.includes(defaultBranch)) page.push(defaultBranch);
  return page;
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
export async function listBranches(
  project: GitBackedProject,
  options: {
    /** A view that may show a listing up to 5 min old (see `branch-list-cache.ts`). */
    allowRecent?: boolean;
  } = {},
): Promise<GitBranchInfo[]> {
  const readUpstream = async () => {
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
    return result.stdout;
  };
  const stdout = options.allowRecent
    ? await recentBranchList(project.projectId, project.repoUrl, readUpstream)
    : await readUpstream();
  const branches = parseRemoteBranches(stdout, project.defaultBranch);
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
      const { ensureManagedRepoSeeded } = await import('../projects/managed-repo-seed');
      const outcome = await ensureManagedRepoSeeded(project.projectId, 'session-branch');
      if (!outcome.repaired) throw error;
      await fetchBase();
    }
    await authGitPush(project, repoPath, [
      'push',
      'origin',
      `refs/heads/${base}:refs/heads/${branch}`,
    ]);
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

  await authGitPush(project, repoPath, ['push', 'origin', `:${branchName}`]);
  await runGit(['update-ref', '-d', `refs/heads/${branchName}`], repoPath, false).catch(
    () => undefined,
  );
  return true;
}
