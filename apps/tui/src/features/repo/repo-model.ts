/**
 * The Repo screen's pure data shapes.
 *
 * The SDK's repository listing gives repo-relative paths (`src/a.ts`). The
 * Files tree helpers want absolute, unique paths with a root, so every repo
 * path maps to a tree path by one leading slash and the root is `/`.
 */

import type { TreeNode } from '../files/index.ts';

/*
 * The SDK root does not export the wire types of the git endpoints, so these
 * are the structural subsets the screen reads. A real `ProjectCommit`,
 * `ProjectBranch` or `DirectoryEntryLike` is assignable to each.
 */
export interface DirectoryEntryLike {
  path: string;
  type: 'file' | 'directory';
}
export interface CommitLike {
  hash: string;
  short_hash: string;
  subject: string;
  author_name: string;
  committed_at: string;
}
export interface BranchLike {
  name: string;
  is_default: boolean;
  subject: string;
  committed_at: string;
  session?: { title: string | null };
}

/** The tree root. A repo path `src/a.ts` is the tree path `/src/a.ts`. */
export const REPO_ROOT = '/';

export interface CommitRow {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  atMs: number;
}

export interface BranchRow {
  name: string;
  isDefault: boolean;
  subject: string;
  atMs: number;
  /** Set on a session branch whose session has a title. */
  sessionTitle: string | null;
}

/** Tree path → repo-relative path. The root is the empty string. */
export function repoPath(treePath: string): string {
  return treePath.replace(/^\/+/, '');
}

/** Repo-relative path → tree path. */
export function treePath(repo: string): string {
  return `/${repo.replace(/^\/+/, '')}`;
}

export function entryToNode(entry: DirectoryEntryLike): TreeNode {
  const path = treePath(entry.path);
  return {
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    type: entry.type,
  };
}

function ms(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

export function toCommitRow(commit: CommitLike): CommitRow {
  return {
    hash: commit.hash,
    shortHash: commit.short_hash || commit.hash.slice(0, 7),
    subject: commit.subject,
    author: commit.author_name,
    atMs: ms(commit.committed_at),
  };
}

export function toBranchRow(branch: BranchLike): BranchRow {
  return {
    name: branch.name,
    isDefault: branch.is_default,
    subject: branch.subject,
    atMs: ms(branch.committed_at),
    sessionTitle: branch.session?.title ?? null,
  };
}

/** Default branch first, then newest commit first. */
export function sortBranches(rows: readonly BranchRow[]): BranchRow[] {
  return [...rows].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    const delta = (Number.isNaN(b.atMs) ? 0 : b.atMs) - (Number.isNaN(a.atMs) ? 0 : a.atMs);
    return delta !== 0 ? delta : a.name.localeCompare(b.name);
  });
}

/** Case-insensitive match on the branch name or its session title. */
export function filterBranches(rows: readonly BranchRow[], query: string): BranchRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter(
    (row) =>
      row.name.toLowerCase().includes(needle) ||
      (row.sessionTitle ?? '').toLowerCase().includes(needle),
  );
}

/** What the history pane is about: one path, or the whole repository. */
export function historyLabel(target: string | null): string {
  return target ? `history · ${target}` : 'history · repository';
}

/** Web URL of the repository files page. */
export function repoWebUrl(webBaseUrl: string, projectId: string): string {
  return `${webBaseUrl.replace(/\/+$/, '')}/projects/${projectId}/files`;
}
