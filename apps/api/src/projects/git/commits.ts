// Commit reads + shared git-log parsing primitives (FIELD/RECORD separators,
// LOG_FORMAT, parseLogStdout, decodeStatusChar) used by branches.ts and
// merge.ts as well.

import { validateRef, validateSha } from '../git-ref';
import { normalizeTreePath, refreshMirror, runGit } from './mirror';
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
export async function resolveCommitSha(project: GitBackedProject, ref?: string): Promise<string> {
  const treeRef = validateRef(ref || project.defaultBranch);
  const repoPath = await refreshMirror(project);
  const result = await runGit(['rev-parse', '--verify', `${treeRef}^{commit}`], repoPath, false);
  const sha = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`Unexpected git rev-parse output for ${treeRef}: ${sha}`);
  }
  return sha;
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
