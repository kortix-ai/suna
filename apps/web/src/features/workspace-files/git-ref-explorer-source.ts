'use client';

import { useCallback } from 'react';
import type { FileExplorerSource } from './explorer-source';
import { downloadFile } from './api/runtime-files';
import { useWorkspaceContext } from './context';
import { useWorkspaceFileSource } from './file-source';
import {
  useFileCopy,
  useFileCreate,
  useFileDelete,
  useFileMkdir,
  useFileRename,
  useFileUpload,
} from './hooks/use-file-mutations';
import { useDirectoryDownload } from './hooks/use-directory-download';
import { useFileEventInvalidation } from '@/features/file-browser/hooks/use-file-events';
import { useFileCommitDiff, useFileHistory } from './hooks/use-file-history';
import { useFileList } from './hooks/use-file-list';
import { useFileSearch } from './hooks/use-file-search';
import { useGitStatus } from './hooks/use-git-status';

function useDownloadFile() {
  const ctx = useWorkspaceContext();
  return useCallback(
    (filePath: string, fileName?: string) =>
      ctx
        ? downloadFile(ctx.workspaceId, ctx.ref, filePath, fileName)
          : Promise.reject(new Error('No workspace context for download')),
    [ctx],
  );
}

/**
 * Read-only, git-ref-backed explorer source. Requires a wrapping
 * <WorkspaceFilesProvider> — every hook resolves workspaceId/ref from it.
 */
export const gitRefExplorerSource: FileExplorerSource = {
  capabilities: {
    write: false,
    search: false,
    hiddenToggle: false,
    gitStatusChip: false,
  },
  useFileViewerSource: useWorkspaceFileSource,
  useFileList,
  useGitStatus,
  useFileEventInvalidation,
  useFileSearch,
  useFileHistory,
  useFileCommitDiff,
  useFileUpload,
  useFileDelete,
  useFileMkdir,
  useFileRename,
  useFileCreate,
  useFileCopy,
  useDirectoryDownload,
  useDownloadFile,
};
