/**
 * Git history API for the project-files feature.
 *
 * Backed by `/v1/projects/:projectId/commits[/...]` and `.../files/history`.
 * Internal types still use Git vocabulary (`commit`, `branch`); the UI layer
 * translates to "Checkpoint" / "Version" for users.
 */

import {
  getProjectCommit,
  getProjectCommitDiff,
  getProjectFileHistory,
  type ProjectCommit,
} from '@/lib/projects-client';
import type { FileCommitDiff, FileHistoryResult, GitCommit } from '../types';

function toGitCommit(c: ProjectCommit): GitCommit {
  const timestamp = Number(new Date(c.committed_at || c.authored_at).getTime()) || Date.now();
  return {
    hash: c.hash,
    shortHash: c.short_hash,
    author: c.author_name,
    authorEmail: c.author_email,
    date: c.committed_at || c.authored_at,
    timestamp,
    subject: c.subject,
    body: c.body,
  };
}

export async function getFileHistory(
  projectId: string,
  ref: string,
  filePath: string,
  options?: { limit?: number; skip?: number },
): Promise<FileHistoryResult> {
  const path = filePath.startsWith('/workspace/')
    ? filePath.slice('/workspace/'.length)
    : filePath.replace(/^\/+/, '');
  const result = await getProjectFileHistory(projectId, path, {
    ref,
    limit: options?.limit,
    skip: options?.skip,
  });
  return {
    filePath,
    commits: result.commits.map(toGitCommit),
    hasMore: result.hasMore,
  };
}

export async function getFileCommitDiff(
  projectId: string,
  filePath: string,
  commitHash: string,
): Promise<FileCommitDiff> {
  const path = filePath.startsWith('/workspace/')
    ? filePath.slice('/workspace/'.length)
    : filePath.replace(/^\/+/, '');

  const [commit, diff] = await Promise.all([
    getProjectCommit(projectId, commitHash),
    getProjectCommitDiff(projectId, commitHash, { path }),
  ]);

  const file = commit.files.find((f) => f.path === path || f.old_path === path);
  const status = file?.status === 'copied' || file?.status === 'typechange'
    ? 'modified'
    : (file?.status ?? 'modified');

  return {
    commitHash: commit.hash,
    parentHash: diff.parent,
    patch: diff.patch,
    before: '',
    after: '',
    additions: file?.additions ?? 0,
    deletions: file?.deletions ?? 0,
    status: status as FileCommitDiff['status'],
  };
}

// Kept for API parity with the legacy stub — not currently used.
export async function getFileAtCommit(): Promise<string> {
  return '';
}
