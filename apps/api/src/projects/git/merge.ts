// Branch diffing & merging (powers the change-request layer) + diffStat.

import { validateRef, validateSha } from '../git-ref';
import {
  hostFromRepoUrl,
  refreshMirror,
  runGit,
  runGitCapture,
} from './mirror';
import { decodeStatusChar, resolveBranchTip } from './commits';
import type {
  BranchDiffSummary,
  GitBackedProject,
  GitCommitFile,
  MergeOptions,
  MergePreview,
  MergeResult,
} from './types';

export async function diffStat(project: GitBackedProject, branchName: string, baseRef?: string) {
  const repoPath = await refreshMirror(project);
  const base = baseRef || project.defaultBranch;
  const result = await runGit(['diff', '--stat', `refs/heads/${base}...refs/heads/${branchName}`], repoPath, false)
    .catch(() => ({ stdout: '', stderr: '' }));
  return { text: result.stdout };
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
