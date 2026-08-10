// Barrel for the git-backed-project operations module.
//
// This module was split into focused files under ./git/ with ZERO behavior
// change. It re-exports the FULL original symbol set so every importer
// (`./git`, `../git`, `../../workspaces/git`) is unchanged.
//
//   types    — all exported interfaces/types (pure leaf)
//   mirror   — shared core: clone/mirror/exec internals + mirror cache +
//              invalidateWorkspaceMirror, resolveTreeOid, materializeRepoContext
//   files    — listRepoFiles, searchRepoFileNames, grepRepoFiles, readRepoFile,
//              archiveRepoSubtree, getFileAtRef, getFileHistory
//   commits  — resolveCommitSha, listCommits, getCommit, getCommitDiff,
//              resolveBranchTip (+ shared git-log parsing primitives)
//   branches — listBranches, createRemoteSessionBranch,
//              deleteRemoteSessionBranch, commitFileToBranch
//   merge    — getMergeBase, getBranchDiff, getDiffBetweenShas, previewMerge,
//              mergeBranches, diffStat
//   config   — loadWorkspaceConfig

export type {
  GitBackedWorkspace,
  WorkspaceFileEntry,
  WorkspaceConfigSummary,
  RepoGrepMatch,
  GitBranchInfo,
  GitLogEntry,
  GitCommitFile,
  GitCommitDetail,
  ListCommitsOptions,
  GetCommitDiffOptions,
  CommitDiff,
  GetFileHistoryOptions,
  GetFileAtRefResult,
  BranchDiffSummary,
  MergePreview,
  MergeOptions,
  MergeResult,
} from './git/types';

export {
  invalidateWorkspaceMirror,
  resolveTreeOid,
  materializeRepoContext,
} from './git/mirror';

export {
  listRepoFiles,
  searchRepoFileNames,
  grepRepoFiles,
  readRepoFile,
  readManifestFromRepo,
  archiveRepoSubtree,
  getFileAtRef,
  getFileHistory,
  RepoFileNotFoundError,
  isRepoFileNotFoundError,
} from './git/files';

export {
  resolveCommitSha,
  listCommits,
  getCommit,
  getCommitDiff,
  resolveBranchTip,
} from './git/commits';

export {
  listBranches,
  remoteBranchExists,
  createRemoteSessionBranch,
  deleteRemoteSessionBranch,
  commitFileToBranch,
} from './git/branches';

export {
  getMergeBase,
  getBranchDiff,
  getDiffBetweenShas,
  previewMerge,
  MergeConflictError,
  mergeBranches,
  diffStat,
  resolveBranchAheadState,
} from './git/merge';

export { loadWorkspaceConfig } from './git/config';
