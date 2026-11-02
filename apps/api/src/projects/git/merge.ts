// Branch diffing & merging (powers the change-request layer) + diffStat.

import { validateRef, validateSha } from '../git-ref';
import {
  ensureCommitTrees,
  ensureStoreObjects,
  hostFromRepoUrl,
  refreshMirror,
  runGit,
  runGitBuffer,
  runGitCapture,
} from './mirror';
import { isObjectFetchTooLargeError } from './object-store';
import { authGitPush } from './commit-writer';
import {
  blobIdsOfChanges,
  DIFF_BLOB_FETCH_MAX_BYTES,
  ensureDiffBlobs,
  parseGitFileChanges,
  parseRawDiff,
  type RawChange,
  resolveBranchTip,
} from './commits';
import type {
  BranchDiffSummary,
  GitBackedProject,
  MergeOptions,
  MergePreview,
  MergeResult,
} from './types';

/** Capture bound for a change-request's full `git diff` patch. The file list
 *  and the per-file counts stay tiny, but the unified diff itself scales with
 *  the change — runGit's 10 MiB default killed the patch command on large CRs
 *  while the swallow below kept serving the (empty) patch as if valid, so the
 *  review page listed files whose bodies could never render (KRTX-2010). */
const DIFF_PATCH_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

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

/**
 * The head refs whose tip is now part of `tipSha`, each with that tip: their
 * work landed through another merge (KRTX-3371). Reads the mirror's refs as
 * they stand, so a head pushed after the last fetch reads as not landed and its
 * request stays open.
 */
export async function headRefsLandedIn(
  project: GitBackedProject,
  tipSha: string,
  headRefs: readonly string[],
): Promise<Map<string, string>> {
  validateSha(tipSha);
  const landed = new Map<string, string>();
  if (headRefs.length === 0) return landed;
  const repoPath = await refreshMirror(project);
  // Git performs the ancestry walk once, rather than spawning two processes
  // per open request (up to 200), after the merge has already been pushed.
  const result = await runGitCapture(
    ['for-each-ref', `--merged=${tipSha}`, '--format=%(refname) %(objectname)', 'refs/heads/'],
    repoPath,
  );
  if (result.exitCode !== 0) throw new Error('Could not classify carried change-request heads');
  const merged = new Map(result.stdout.trim().split('\n').map((line) => {
    const [ref, sha] = line.split(' ');
    return [ref, sha];
  }));
  for (const ref of headRefs) {
    try {
      validateRef(ref);
    } catch {
      continue;
    }
    const sha = merged.get(`refs/heads/${ref}`);
    if (sha && /^[0-9a-f]{40}$/.test(sha)) landed.set(ref, sha);
  }
  return landed;
}

export interface BranchAheadState {
  /** True when headRef carries at least one commit baseRef doesn't — i.e. a
   *  CR from head into base would be non-empty. False covers BOTH failure
   *  shapes: head tip equal to base (committed-but-never-pushed session
   *  branch) and head strictly behind an advanced base (merge-base == head). */
  ahead: boolean;
  baseSha: string;
  headSha: string;
}

/**
 * Resolve both branch tips and decide whether head is ahead of base. The
 * mirror serves refs up to KORTIX_GIT_REFRESH_INTERVAL_MS stale and the
 * caller (CR open) typically runs moments after the author's `git push` —
 * so when the cached refs say "not ahead", force ONE fetch and re-check
 * before answering: a just-pushed branch must never read as empty.
 */
export async function resolveBranchAheadState(
  project: GitBackedProject,
  baseRef: string,
  headRef: string,
): Promise<BranchAheadState> {
  validateRef(baseRef);
  validateRef(headRef);
  const resolve = async (): Promise<BranchAheadState> => {
    const [baseSha, headSha] = await Promise.all([
      resolveBranchTip(project, baseRef),
      resolveBranchTip(project, headRef),
    ]);
    if (baseSha === headSha) return { ahead: false, baseSha, headSha };
    const mergeBase = await getMergeBase(project, baseRef, headRef);
    return { ahead: mergeBase !== headSha, baseSha, headSha };
  };
  let cached: BranchAheadState;
  try {
    cached = await resolve();
  } catch {
    // A session branch can be pushed while another caller owns the project's
    // mirror-refresh lock. That refresh can finish before the push reaches the
    // remote, which leaves the warm mirror without the new ref. Re-fetch once
    // after the first lookup fails. Persistent missing refs and auth failures
    // still fail on the second lookup.
    await refreshMirror(project, true);
    return resolve();
  }
  if (cached.ahead) return cached;
  await refreshMirror(project, true);
  return resolve();
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

  // On a partial store (object-store.ts) the file list reads the trees of the
  // merge base and the head. Line counts, rename detection and the patch also
  // read both versions of every changed file: fetch them in one request,
  // bounded by DIFF_BLOB_FETCH_MAX_BYTES. Over the bound the review lists the
  // files without renames, counts or patch (`patch_truncated`).
  await ensureCommitTrees(repoPath, [headSha, ...(mergeBase ? [mergeBase] : [])]);
  const withContent = await ensureDiffBlobs(repoPath, ['diff'], [range]);
  const renames = withContent ? '-M' : '--no-renames';

  // The file-list commands stay small (one short record per file) and are
  // allowed to fail into empty output; the PATCH command is the one that can
  // exceed runGit's 10 MiB exec cap on a big change (ERR_CHILD_PROCESS_STDIO_MAXBUFFER,
  // or the 30 s timeout). A patch in the 10–32 MiB band is captured with the
  // larger bound so the review page renders its real contents; only a patch
  // over the 32 MiB bound fails, and that failure is flagged (`patch_truncated`)
  // instead of silently empty — the review page then shows an explicit per-file
  // state (KRTX-2010).
  const noOutput = { stdout: '', stderr: '' };
  const readPatch = () =>
    runGitBuffer(
      ['diff', '--no-color', '-M', range],
      repoPath,
      false,
      null,
      undefined,
      'github.com',
      undefined,
      undefined,
      DIFF_PATCH_MAX_BUFFER_BYTES,
    )
      .then((r) => ({ stdout: r.stdout.toString(), truncated: false }))
      .catch(() => ({ stdout: '', truncated: true }));
  const [nameStatus, numstat, patchResult] = await Promise.all([
    runGit(['diff', '--name-status', '-z', renames, range], repoPath, false).catch(() => noOutput),
    withContent ? runGit(['diff', '--numstat', '-M', range], repoPath, false).catch(() => noOutput) : noOutput,
    withContent ? readPatch() : { stdout: '', truncated: true },
  ]);

  const { files, additions, deletions } = parseGitFileChanges(nameStatus.stdout, numstat.stdout);
  return {
    files,
    files_changed: files.length,
    additions,
    deletions,
    patch: patchResult.stdout,
    patch_truncated: patchResult.truncated,
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
 * Extract the conflicting paths from `git merge-tree --write-tree --name-only`.
 * Git writes the generated tree SHA first. It then writes one path per line
 * until the first blank line and the human-readable conflict diagnostics.
 */
export function parseMergeTreeConflictPaths(stdout: string): string[] {
  const conflicts: string[] = [];
  let started = false;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!started) {
      if (/^[0-9a-f]{40}$/.test(line)) started = true;
      continue;
    }
    if (!line) break;
    if (line.startsWith('Auto-merging ') || line.startsWith('CONFLICT ')) break;
    conflicts.push(line);
  }
  return conflicts;
}

export class MergeConflictError extends Error {
  readonly code = 'MERGE_CONFLICT';

  constructor(readonly conflicts: string[]) {
    super('Merge conflicts detected. Solve them with an agent before applying this change.');
    this.name = 'MergeConflictError';
  }
}

/** One side of a merge: what changed from the merge base, by path. Reads trees only. */
async function changesFromBase(repoPath: string, mergeBase: string, tip: string): Promise<Map<string, RawChange>> {
  const listed = await runGit(
    ['diff-tree', '-r', '-z', '--no-renames', '--no-abbrev', mergeBase, tip],
    repoPath,
    false,
  );
  return new Map(parseRawDiff(listed.stdout).map((change) => [change.path, change]));
}

/**
 * Make the files `git merge-tree` reads present on a partial store
 * (object-store.ts): the trees of the three commits, and the blobs of every
 * path both sides changed (the base version and each side's version). A path
 * one side deleted and the other changed also needs the files the deleting
 * side added: merge-tree compares them to find a rename. Any other object it
 * reads arrives through the store's per-object fetch. Over
 * DIFF_BLOB_FETCH_MAX_BYTES nothing is prefetched.
 */
async function ensureMergeObjects(repoPath: string, mergeBase: string | null, baseSha: string, headSha: string): Promise<void> {
  if (!mergeBase) return;
  await ensureCommitTrees(repoPath, [mergeBase, baseSha, headSha]);
  const [ours, theirs] = await Promise.all([
    changesFromBase(repoPath, mergeBase, baseSha),
    changesFromBase(repoPath, mergeBase, headSha),
  ]);
  const wanted: RawChange[] = [];
  let oursDeletedShared = false;
  let theirsDeletedShared = false;
  for (const [path, mine] of ours) {
    const other = theirs.get(path);
    if (!other) continue;
    wanted.push(mine, other);
    oursDeletedShared ||= mine.status === 'D';
    theirsDeletedShared ||= other.status === 'D';
  }
  // A rename target is a file the deleting side added.
  if (oursDeletedShared) wanted.push(...[...ours.values()].filter((change) => change.status === 'A'));
  if (theirsDeletedShared) wanted.push(...[...theirs.values()].filter((change) => change.status === 'A'));
  try {
    await ensureStoreObjects(repoPath, blobIdsOfChanges(wanted), { maxBytes: DIFF_BLOB_FETCH_MAX_BYTES });
  } catch (error) {
    if (!isObjectFetchTooLargeError(error)) throw error;
  }
}

/**
 * Run `git merge-tree --write-tree`. Exit 0 is a clean merge and exit 1 is a
 * conflict. Any other exit is a failure (an object the store could not
 * fetch, a bad ref) and must not read as "conflicts" with an empty list.
 */
async function runMergeTree(project: GitBackedProject, repoPath: string, baseRef: string, headRef: string) {
  const result = await runGitCapture(
    ['merge-tree', '--write-tree', '--name-only', `refs/heads/${baseRef}`, `refs/heads/${headRef}`],
    repoPath,
    project.gitAuthToken,
    undefined,
    hostFromRepoUrl(project.repoUrl),
    project.gitAuthHeaders,
  );
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`git merge-tree failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 500)}`);
  }
  return result;
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

  await ensureMergeObjects(repoPath, mergeBase, baseSha, headSha);
  const result = await runMergeTree(project, repoPath, baseRef, headRef);

  let canMerge = true;
  if (result.exitCode !== 0) {
    canMerge = false;
  }
  const conflicts = canMerge ? [] : parseMergeTreeConflictPaths(result.stdout);

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
    await authGitPush(project, repoPath, ['push', 'origin', `${headSha}:refs/heads/${baseRef}`]);
    return {
      merge_commit_sha: headSha,
      fast_forward: true,
      base_sha_before: baseShaBefore,
      base_sha_after: headSha,
    };
  }

  // 3-way merge.
  await ensureMergeObjects(repoPath, mergeBase, baseShaBefore, headSha);
  const mergeTreeResult = await runMergeTree(project, repoPath, baseRef, headRef);
  if (mergeTreeResult.exitCode !== 0) {
    throw new MergeConflictError(parseMergeTreeConflictPaths(mergeTreeResult.stdout));
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
  // `--no-thin`: see commit-writer.ts. A thin pack reads the previous version
  // of each merged file to delta against it.
  await authGitPush(project, repoPath, [
    'push',
    '--no-thin',
    'origin',
    `${mergeCommitSha}:refs/heads/${baseRef}`,
  ]);

  return {
    merge_commit_sha: mergeCommitSha,
    fast_forward: false,
    base_sha_before: baseShaBefore,
    base_sha_after: mergeCommitSha,
  };
}
