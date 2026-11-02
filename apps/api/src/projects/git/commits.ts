// Commit reads + shared git-log parsing primitives (FIELD/RECORD separators,
// LOG_FORMAT, parseLogStdout, decodeStatusChar) used by branches.ts and
// merge.ts as well.

import { existsSync } from 'node:fs';
import { validateRef, validateSha } from '../git-ref';
import {
  ensureCommitTrees,
  ensureStoreObjects,
  type MirrorRefresh,
  normalizeTreePath,
  refreshMirror,
  repoCachePath,
  runGit,
} from './mirror';
import { isObjectFetchTooLargeError } from './object-store';
import type {
  CommitDiff,
  GetCommitDiffOptions,
  GitBackedProject,
  GitCommitDetail,
  GitCommitFile,
  GitLogEntry,
  ListCommitsOptions,
} from './types';

export const FIELD_SEP = '';
export const RECORD_SEP = '';
export const LOG_FORMAT = [
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

export function parseLogStdout(stdout: string): GitLogEntry[] {
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

export function decodeStatusChar(code: string): GitCommitFile['status'] {
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

/**
 * Resolve a ref (branch name, tag, "HEAD") to a full 40-char commit SHA.
 * Used by the snapshot builder to pin a build to a specific commit even
 * when the default branch moves underneath it.
 */
export async function resolveCommitSha(
  project: GitBackedProject,
  ref?: string,
  freshness: Extract<MirrorRefresh, false | 'tip-proof'> = false,
): Promise<string> {
  const treeRef = validateRef(ref || project.defaultBranch);
  const repoPath = await (freshness
    ? refreshMirror(project, freshness, { freshRef: treeRef })
    : refreshMirror(project));
  return resolveCommitShaAt(repoPath, treeRef);
}

/** `ref` as this replica's mirror holds it now: no refresh, no network. Null without a mirror. */
export async function readMirrorCommitSha(project: GitBackedProject, ref?: string): Promise<string | null> {
  const repoPath = repoCachePath(project);
  if (!existsSync(repoPath)) return null;
  return resolveCommitShaAt(repoPath, validateRef(ref || project.defaultBranch)).catch(() => null);
}

/**
 * `git rev-parse --verify <ref>^{commit}` against an already-resolved repo —
 * no mirror refresh. The one rev-parse site for commits.ts and
 * fast-boot-bundle.ts. Git command failures propagate untouched; only a
 * non-hex answer becomes the typed error below, so each caller keeps its own
 * mapping (the boundary returns null, the project wrappers rethrow).
 */
export class UnexpectedRevParseOutputError extends Error {
  constructor(treeRef: string, output: string) {
    super(`Unexpected git rev-parse output for ${treeRef}: ${output}`);
    this.name = 'UnexpectedRevParseOutputError';
  }
}

export async function resolveCommitShaAt(repoPath: string, treeRef: string): Promise<string> {
  const result = await runGit(['rev-parse', '--verify', `${treeRef}^{commit}`], repoPath, false);
  const sha = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new UnexpectedRevParseOutputError(treeRef, sha);
  return sha;
}

/**
 * Bytes of file content one diff may fetch into a partial store
 * (`object-store.ts`) for its line counts, renames and patch. Over it, the
 * diff degrades to the file list.
 */
export const DIFF_BLOB_FETCH_MAX_BYTES = 64 * 1024 * 1024;

/** Bytes of trees one file-history read may fetch. Over it, the read relies on per-object fetches. */
const HISTORY_TREES_MAX_BYTES = 64 * 1024 * 1024;

// replica-local: stores on this replica whose history trees exceeded HISTORY_TREES_MAX_BYTES.
const historyTreesTooLarge = new Set<string>();

/** One changed path in `--raw -z --no-abbrev` output. */
export interface RawChange {
  path: string;
  oldMode: string;
  newMode: string;
  oldId: string;
  newId: string;
  /** `A`, `D`, `M`, `T` (no renames: the listing runs with `--no-renames`). */
  status: string;
}

/**
 * Parse `--raw -z --no-abbrev --no-renames` output. Tokens that are not a
 * change record (the commit id `diff-tree` prints first) are skipped.
 */
export function parseRawDiff(raw: string): RawChange[] {
  const changes: RawChange[] = [];
  const tokens = raw.split('\0');
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])/.exec(tokens[i]!);
    if (!match) continue;
    changes.push({
      path: tokens[i + 1]!,
      oldMode: match[1]!,
      newMode: match[2]!,
      oldId: match[3]!,
      newId: match[4]!,
      status: match[5]!,
    });
    i += 1;
  }
  return changes;
}

/**
 * The blob ids of `changes` (both sides). Submodule entries (mode 160000)
 * name commits of another repository, and the zero id names no object.
 */
export function blobIdsOfChanges(changes: Iterable<RawChange>): string[] {
  const ids = new Set<string>();
  for (const change of changes) {
    if (change.oldMode !== '160000' && !/^0{40}$/.test(change.oldId)) ids.add(change.oldId);
    if (change.newMode !== '160000' && !/^0{40}$/.test(change.newId)) ids.add(change.newId);
  }
  return [...ids];
}

/**
 * Make the blobs a diff compares present, so `--numstat`, `-M` and the patch
 * run on a partial store. `command` is the diff command and its options
 * (`['diff']`, `['diff-tree', '-r', '--root']`); `operands` are the revisions
 * and the pathspec. The listing runs without rename detection, which reads
 * trees only. Returns false when the blobs weigh more than `maxBytes`
 * (default `DIFF_BLOB_FETCH_MAX_BYTES`): nothing is kept, and the caller lists the
 * files without renames, line counts or patch.
 */
export async function ensureDiffBlobs(
  repoPath: string,
  command: string[],
  operands: string[],
  maxBytes: number = DIFF_BLOB_FETCH_MAX_BYTES,
): Promise<boolean> {
  // A listing that fails names no blobs. The diff that follows fails the
  // same way and reports it.
  const listed = await runGit([...command, '--raw', '-z', '--no-renames', '--no-abbrev', ...operands], repoPath, false)
    .catch(() => null);
  if (!listed) return true;
  try {
    await ensureStoreObjects(repoPath, blobIdsOfChanges(parseRawDiff(listed.stdout)), { maxBytes });
    return true;
  } catch (error) {
    if (isObjectFetchTooLargeError(error)) return false;
    throw error;
  }
}

/**
 * A path-limited `git log` reads the tree of every commit it walks. It walks
 * back until it finds enough commits that touch the path: for a file that
 * rarely changes, that is the whole history. Make the trees of every commit
 * reachable from `ref` present, in one request and without file content.
 * The root tree ids come from the commits, which the store always holds.
 */
async function ensureHistoryTrees(repoPath: string, ref: string): Promise<void> {
  if (historyTreesTooLarge.has(repoPath)) return;
  const listed = await runGit(['log', '--format=%T', ref, '--'], repoPath, false).catch(() => null);
  if (!listed) return;
  const trees = listed.stdout.split('\n').map((line) => line.trim()).filter((id) => /^[0-9a-f]{40}$/.test(id));
  try {
    await ensureStoreObjects(repoPath, trees, { maxBytes: HISTORY_TREES_MAX_BYTES });
  } catch (error) {
    if (!isObjectFetchTooLargeError(error)) throw error;
    // Each attempt would transfer the cap again and keep nothing. The log
    // still runs: the store fetches up to 32 trees that git names.
    historyTreesTooLarge.add(repoPath);
  }
}

/** The commit changes more file content than a diff may fetch (`DIFF_BLOB_FETCH_MAX_BYTES`). */
export class CommitDiffTooLargeError extends Error {
  constructor(readonly sha: string) {
    super(`Commit ${sha} changes more than ${DIFF_BLOB_FETCH_MAX_BYTES / 1024 / 1024} MB of file content. Its patch is not available.`);
    this.name = 'CommitDiffTooLargeError';
  }
}

/** Renames a file history follows at most. */
const MAX_FOLLOWED_RENAMES = 16;

/**
 * The path that `commit` renamed to `path`, or null. Exact renames (same
 * content) read trees only. Otherwise git compares the added file with the
 * files the commit deleted, so those blobs are fetched first, bounded by
 * DIFF_BLOB_FETCH_MAX_BYTES.
 */
async function renameSource(repoPath: string, commit: string, path: string): Promise<string | null> {
  const listed = await runGit(['diff-tree', '-r', '-z', '--no-renames', '--no-abbrev', commit], repoPath, false);
  const changes = parseRawDiff(listed.stdout);
  const added = changes.find((change) => change.path === path && change.status === 'A');
  const deleted = changes.filter((change) => change.status === 'D' && change.oldMode === added?.newMode);
  if (!added || deleted.length === 0) return null;
  const exact = deleted.find((change) => change.oldId === added.newId);
  if (exact) return exact.path;
  try {
    await ensureStoreObjects(repoPath, blobIdsOfChanges([added, ...deleted]), { maxBytes: DIFF_BLOB_FETCH_MAX_BYTES });
  } catch (error) {
    if (isObjectFetchTooLargeError(error)) return null;
    throw error;
  }
  // The pathspec keeps rename detection to these pairs: other files the
  // commit added are not read.
  const renamed = await runGit(
    ['--literal-pathspecs', 'diff-tree', '-r', '-z', '-M', '--name-status', commit, '--', path, ...deleted.map((change) => change.path)],
    repoPath,
    false,
  );
  const tokens = renamed.stdout.split('\0');
  for (let i = 0; i + 2 < tokens.length; i += 1) {
    if (tokens[i]!.startsWith('R') && tokens[i + 2] === path) return tokens[i + 1]!;
  }
  return null;
}

/**
 * The newest `count` commits that touch `path` from `ref`, across renames:
 * what `git log --follow` lists. `--follow` itself cannot run on a partial
 * store (object-store.ts): where the path appears, it compares the new file
 * with every file of the parent commit to find a copy, so it reads the
 * content of the whole tree. This walk reads trees, and file content only
 * where the path was added and the same commit deleted files.
 */
async function followedPathLog(repoPath: string, ref: string, path: string, count: number): Promise<GitLogEntry[]> {
  const entries: GitLogEntry[] = [];
  let rev = ref;
  let current = path;
  for (let renames = 0; ; renames += 1) {
    const want = count - entries.length;
    const result = await runGit(
      ['--literal-pathspecs', 'log', rev, `--pretty=format:${LOG_FORMAT}`, '-n', String(want), '--', current],
      repoPath,
      false,
    );
    const segment = parseLogStdout(result.stdout);
    entries.push(...segment);
    // A full segment may continue past its oldest commit. A short one ends
    // where the path first appears: a root commit, or a commit that added it.
    if (segment.length === 0 || segment.length >= want || renames >= MAX_FOLLOWED_RENAMES) return entries;
    // `%P` of a path-limited log names rewritten parents: read the real ones.
    const oldest = segment[segment.length - 1]!.hash;
    const parents = (await runGit(['rev-list', '--parents', '-n', '1', oldest], repoPath, false)).stdout.trim().split(/\s+/).slice(1);
    if (parents.length !== 1) return entries;
    const source = await renameSource(repoPath, oldest, current);
    if (!source) return entries;
    rev = parents[0]!;
    current = source;
  }
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

  // `--literal-pathspecs`: the path names a file, never a pattern. As a glob,
  // `agents/x.m*` or `*x*` read the history of a file that the resource
  // denier hides under its own name (KRTX-3403).
  let entries: GitLogEntry[];
  if (treePath) {
    await ensureHistoryTrees(repoPath, ref);
    entries = (await followedPathLog(repoPath, ref, treePath, skip + limit + 1)).slice(skip);
  } else {
    const result = await runGit(
      ['log', ref, `--pretty=format:${LOG_FORMAT}`, '-n', String(limit + 1), '--skip', String(skip)],
      repoPath,
      false,
    );
    entries = parseLogStdout(result.stdout);
  }
  const hasMore = entries.length > limit;
  return {
    commits: hasMore ? entries.slice(0, limit) : entries,
    hasMore,
  };
}

/**
 * Parse the paired `--name-status -z` and `--numstat` outputs of one diff
 * into the shared file shape. `nameStatus` is NUL-separated; rename/copy
 * entries take two extra NULs (old path first). `numstat` carries the
 * per-file +/- counts and emits renamed paths as `old{ => new}` — matched by
 * destination, else the raw path. Totals count every numstat line, whether or
 * not the name-status pass kept the file (`getCommit` ignores them,
 * `computeDiffByRange` reports them).
 */
export function parseGitFileChanges(
  nameStatus: string,
  numstat: string,
): { files: GitCommitFile[]; additions: number; deletions: number } {
  const files = new Map<string, GitCommitFile>();
  const tokens = nameStatus.split('\0');
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

  let additions = 0;
  let deletions = 0;
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [addStr, delStr, rawPath] = parts;
    const destMatch = rawPath.match(/\{[^}]*=>\s*([^}]+)\}/);
    const path = destMatch
      ? rawPath.replace(/\{[^}]*=>\s*([^}]+)\}/, '$1')
      : rawPath;
    const addCount = addStr === '-' ? 0 : Number(addStr) || 0;
    const delCount = delStr === '-' ? 0 : Number(delStr) || 0;
    additions += addCount;
    deletions += delCount;
    const existing = files.get(path);
    if (existing) {
      existing.additions = addCount;
      existing.deletions = delCount;
    }
  }

  return { files: Array.from(files.values()), additions, deletions };
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
  //
  // On a partial store the list reads the trees of the commit and its parent.
  // Line counts and rename detection also read the changed files. Without -m
  // a merge commit lists nothing, so its parents' trees are not needed.
  await ensureCommitTrees(repoPath, [entry.hash, ...(entry.parents.length === 1 ? entry.parents : [])]);
  const withContent = await ensureDiffBlobs(repoPath, ['diff-tree', '-r', '--no-commit-id', '--root'], [sha]);
  const renames = withContent ? ['-M'] : [];
  const [nameStatus, numstat] = await Promise.all([
    runGit(
      ['diff-tree', '-r', '--no-commit-id', '--name-status', '-z', '--root', ...renames, sha],
      repoPath,
      false,
    ).catch(() => ({ stdout: '', stderr: '' })),
    withContent
      ? runGit(
          ['diff-tree', '-r', '--no-commit-id', '--numstat', '--root', '-M', sha],
          repoPath,
          false,
        ).catch(() => ({ stdout: '', stderr: '' }))
      : { stdout: '', stderr: '' },
  ]);

  const { files } = parseGitFileChanges(nameStatus.stdout, numstat.stdout);
  return { ...entry, files };
}

export async function getCommitDiff(
  project: GitBackedProject,
  sha: string,
  options: GetCommitDiffOptions = {},
): Promise<CommitDiff> {
  const repoPath = await refreshMirror(project);
  validateSha(sha);

  const treePath = normalizeTreePath(options.path ?? null);
  const pathspec = treePath ? ['--', treePath] : [];

  // `<commit> <parent>...`, read from the commit object alone.
  let ids: string[] = [];
  try {
    const parentRes = await runGit(
      ['rev-list', '--parents', '-n', '1', sha],
      repoPath,
      false,
    );
    ids = parentRes.stdout.trim().split(/\s+/).filter(Boolean);
  } catch {
    ids = [];
  }

  // The patch reads the trees of the commit and its parent and both versions
  // of every changed file (of `path` only, when set). Fetch them first, in
  // one request each. Without -m a merge commit prints no patch.
  await ensureCommitTrees(repoPath, ids.length === 2 ? ids : ids.slice(0, 1));
  if (!(await ensureDiffBlobs(repoPath, ['--literal-pathspecs', 'diff-tree', '-r', '--root'], [sha, ...pathspec]))) {
    throw new CommitDiffTooLargeError(sha);
  }

  const result = await runGit(
    ['--literal-pathspecs', 'diff-tree', '-p', '--root', '-M', '--no-color', sha, ...pathspec],
    repoPath,
    false,
  );

  return { hash: sha, parent: ids[1] ?? null, patch: result.stdout };
}

/** Resolves a branch name to its tip commit SHA (full 40-char hex). */
export async function resolveBranchTip(
  project: GitBackedProject,
  ref: string,
): Promise<string> {
  validateRef(ref);
  const repoPath = await refreshMirror(project);
  // refs/heads/<ref> stays fully qualified: a tag must never shadow a branch.
  return resolveCommitShaAt(repoPath, `refs/heads/${ref}`);
}
