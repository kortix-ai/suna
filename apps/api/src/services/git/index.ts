// Barrel for the git-backed-project operations module.
//
// This module was split into focused files under ./git/ with ZERO behavior
// change. It re-exports the FULL original symbol set so every importer
// (`./index`, `../git`, `../../projects/git`) is unchanged.
//
//   types    — all exported interfaces/types (pure leaf)
//   mirror   — shared core: clone/mirror/exec internals + mirror cache +
//              invalidateProjectMirror, resolveTreeOid, materializeRepoContext
//   files    — listRepoFiles, searchRepoFileNames, grepRepoFiles, readRepoFile,
//              archiveRepoSubtree, getFileAtRef, getFileHistory
//   commits  — resolveCommitSha, listCommits, getCommit, getCommitDiff,
//              resolveBranchTip (+ shared git-log parsing primitives)
//   branches — listBranches, createRemoteSessionBranch,
//              deleteRemoteSessionBranch, commitFileToBranch
//   merge    — getMergeBase, getBranchDiff, getDiffBetweenShas, previewMerge,
//              mergeBranches, diffStat
//   config   — loadProjectConfig

export type {
  GitBackedProject,
  ProjectFileEntry,
  ProjectConfigSummary,
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
} from './types';

export {
  invalidateProjectMirror,
  resolveTreeOid,
  materializeRepoContext,
  type MirrorRefresh,
} from './mirror';

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
} from './files';

export {
  resolveCommitSha,
  resolveFastBootGitHint,
  buildSingleParentDeltaBundle,
  listCommits,
  getCommit,
  getCommitDiff,
  resolveBranchTip,
} from './commits';

export {
  listBranches,
  remoteBranchExists,
  resolveRemoteBranchTip,
  createRemoteSessionBranch,
  deleteRemoteSessionBranch,
  commitFileToBranch,
  isSessionBranchName,
  filterBranchesForResponse,
  BRANCH_LIST_DEFAULT_LIMIT,
  BRANCH_LIST_MAX_LIMIT,
} from './branches';
export type { BranchListFilter } from './branches';

export {
  getMergeBase,
  getBranchDiff,
  getDiffBetweenShas,
  previewMerge,
  MergeConflictError,
  mergeBranches,
  diffStat,
  resolveBranchAheadState,
} from './merge';

export { loadProjectConfig } from './config';
