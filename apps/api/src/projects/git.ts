// Barrel for the git-backed-project operations module.
//
// This module was split into focused files under ./git/ with ZERO behavior
// change. It re-exports the FULL original symbol set so every importer
// (`./git`, `../git`, `../../projects/git`) is unchanged.
//
//   types    — all exported interfaces/types (pure leaf)
//   mirror   — shared core: clone/mirror/exec internals + mirror cache +
//              invalidateProjectMirror, resolveTreeOid, materializeRepoContext
//   files    — listRepoFiles, searchRepoFileNames, grepRepoFiles, readRepoFile,
//              archiveRepoSubtree, getFileAtRef, getFileHistory
//   commits  — resolveCommitSha, listCommits, getCommit, getCommitDiff,
//              resolveBranchTip (+ shared git-log parsing primitives)
//   fast-boot-bundle — resolveFastBootGitHint and the scaffold-delta bundle
//              builders (session fast-boot provisioning)
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
  BranchDiffSummary,
  MergePreview,
  MergeOptions,
  MergeResult,
} from './git/types';

export {
  invalidateProjectMirror,
  materializeRepoContext,
  type MirrorRefresh,
} from './git/mirror';

export {
  listRepoFiles,
  searchRepoFileNames,
  grepRepoFiles,
  readRepoFile,
  readRepoFileBytes,
  readManifestFromRepo,
  archiveRepoSubtree,
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

export { resolveFastBootGitHint } from './git/fast-boot-bundle';

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
} from './git/branches';
export type { BranchListFilter } from './git/branches';

export {
  getMergeBase,
  getBranchDiff,
  getDiffBetweenShas,
  previewMerge,
  MergeConflictError,
  mergeBranches,
  resolveBranchAheadState,
} from './git/merge';

export { loadProjectConfig } from './git/config';
