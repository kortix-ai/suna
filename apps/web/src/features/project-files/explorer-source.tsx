'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { FileSource } from '@/features/file-viewer';
import type {
  FileCommitDiff,
  FileHistoryResult,
  FileNode,
  GitFileStatus,
} from './types';

/**
 * Data-access contract for the shared Drive-style file explorer
 * (<DriveExplorer> and its data-touching children: toolbar refresh, search
 * overlay, history popover, thumbnails, preview modal).
 *
 * Extends the `features/file-viewer` FileSource idea to the whole explorer:
 * each surface supplies its own implementation —
 *   • live sandbox workspace (`features/files` hooks, writable) — the session
 *     side panel;
 *   • project git-ref view (`features/project-files` hooks, read-only) — the
 *     customize → Files section.
 *
 * All `use*` members are React hooks. The explorer calls them unconditionally
 * at the top level on every render, so implementations must obey the rules of
 * hooks. Provide the source as a module constant (or memoized value) so hook
 * identity is stable across renders.
 */

export interface ExplorerCapabilities {
  /** Mutations allowed: upload, create, rename, delete, move, paste. */
  write: boolean;
  /** Cmd+P file-name search overlay + toolbar search button. */
  search: boolean;
  /** Dotfile show/hide toggle in the toolbar (list is pre-filtered by the hook). */
  hiddenToggle: boolean;
  /** Per-file git-status chip in the preview modal header. */
  gitStatusChip: boolean;
}

export interface ExplorerQueryResult<T> {
  data: T | undefined;
  isLoading: boolean;
  isFetching?: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
}

export interface ExplorerMutation<TArgs> {
  mutateAsync: (args: TArgs) => Promise<unknown>;
  isPending: boolean;
}

export interface FileExplorerSource {
  capabilities: ExplorerCapabilities;

  /**
   * Data source for the shared file viewer / preview modal / thumbnails.
   * A hook because ref-scoped implementations build it from context.
   */
  useFileViewerSource: () => FileSource;

  // ── Queries ────────────────────────────────────────────────────
  useFileList: (dirPath: string) => ExplorerQueryResult<FileNode[]>;
  useGitStatus: () => { data: GitFileStatus[] | undefined };
  /** Real-time list/content invalidation (SSE file events). May be a no-op. */
  useFileEventInvalidation: () => void;
  useFileSearch: (
    query: string,
    options?: { type?: 'file' | 'directory'; limit?: number; enabled?: boolean },
  ) => { data: string[] | undefined; isLoading: boolean; error: unknown };
  useFileHistory: (filePath: string | null) => ExplorerQueryResult<FileHistoryResult>;
  useFileCommitDiff: (
    filePath: string | null,
    commitHash: string | null,
  ) => ExplorerQueryResult<FileCommitDiff>;

  // ── Mutations (read-only sources reject; the UI never invokes them) ──
  useFileUpload: () => ExplorerMutation<{ file: File | Blob; targetPath?: string }>;
  useFileDelete: () => ExplorerMutation<{ filePath: string }>;
  useFileMkdir: () => ExplorerMutation<{ dirPath: string }>;
  useFileRename: () => ExplorerMutation<{ from: string; to: string }>;
  useFileCreate: () => ExplorerMutation<{ filePath: string }>;
  useFileCopy: () => ExplorerMutation<{ sourcePath: string; destPath: string }>;

  // ── Downloads ──────────────────────────────────────────────────
  useDirectoryDownload: () => {
    downloadDir: (dirPath: string, dirName: string) => void;
    isDownloading: (dirPath: string) => boolean;
  };
  /** Download a single file to the user's machine. */
  useDownloadFile: () => (filePath: string, fileName?: string) => Promise<void>;
}

const FileExplorerSourceContext = createContext<FileExplorerSource | null>(null);

export function FileExplorerSourceProvider({
  value,
  children,
}: {
  value: FileExplorerSource;
  children: ReactNode;
}) {
  return (
    <FileExplorerSourceContext.Provider value={value}>
      {children}
    </FileExplorerSourceContext.Provider>
  );
}

export function useFileExplorerSource(): FileExplorerSource {
  const ctx = useContext(FileExplorerSourceContext);
  if (!ctx) {
    throw new Error(
      'useFileExplorerSource: a <FileExplorerSourceProvider> must wrap the file explorer',
    );
  }
  return ctx;
}
