/**
 * File Browser — shared layer between `features/files` (live-sandbox
 * read/write browser) and `features/project-files` (read-only, git-ref-scoped
 * Drive UX). See docs/specs/2026-07-04-files-source-collapse.md for the full
 * design and migration plan.
 *
 * Only genuinely source-agnostic modules live here: pure UI state, pure
 * logic with zero dependency on a divergent sibling (SDK client, file-icon
 * set, etc.), and presentational components that take their one or two
 * source-specific dependencies as props instead of importing them directly.
 */

// Types shared by both file sources
export type {
  FileNode,
  FileContent,
  FilePatch,
  FilePatchHunk,
  FindMatch,
  LssHit,
  LssSearchResult,
  OpenCodeProjectInfo,
  ServerHealth,
  GitCommit,
  FileHistoryResult,
  FileCommitDiff,
} from './types';

// UI state store (view/selection/clipboard/tree-expansion/sort — carries no
// data-source dependency at all)
export {
  createFilesStore,
  FilesStoreProvider,
  globalFilesStore,
  useFilesStore,
  useFilesStoreApi,
  isWithinRoot,
  type FilesView,
  type ViewMode,
  type SortField,
  type SortOrder,
  type ClipboardOperation,
  type ClipboardItem,
  type FilesStore,
  type FilesStoreApi,
} from './store/files-store';

// React Query cache invalidation on file-system events (source-agnostic —
// just invalidates well-known query key prefixes)
export { useFileEventInvalidation } from './hooks/use-file-events';

// Client-side workspace search core (pure text/matching logic over an
// in-memory file index; the network fetch is source-specific and stays in
// each tree's `workspace-search-service.ts`)
export * from './search/workspace-search-core';

// Presentational tree row — takes its icon resolver and its one differing
// label ("View History" vs "Checkpoint history") as props
export { FileTreeItem, type GitStatusType } from './components/file-tree-item';
