'use client';

import { useCallback } from 'react';
import type { FileExplorerSource } from './explorer-source';
import { downloadFile } from './api/opencode-files';
import { useProjectContext } from './context';
import { useProjectFileSource } from './file-source';
import {
  useFileCopy,
  useFileCreate,
  useFileDelete,
  useFileMkdir,
  useFileRename,
  useFileUpload,
} from './hooks/use-file-mutations';
import { useDirectoryDownload } from './hooks/use-directory-download';
import { useFileEventInvalidation } from './hooks/use-file-events';
import { useFileCommitDiff, useFileHistory } from './hooks/use-file-history';
import { useFileList } from './hooks/use-file-list';
import { useFileSearch } from './hooks/use-file-search';
import { useGitStatus } from './hooks/use-git-status';

function useDownloadFile() {
  const ctx = useProjectContext();
  return useCallback(
    (filePath: string, fileName?: string) =>
      ctx
        ? downloadFile(ctx.projectId, ctx.ref, filePath, fileName)
        : Promise.reject(new Error('No project context for download')),
    [ctx],
  );
}

/**
 * Read-only, git-ref-backed explorer source. Requires a wrapping
 * <ProjectFilesProvider> — every hook resolves projectId/ref from it.
 */
export const gitRefExplorerSource: FileExplorerSource = {
  capabilities: {
    write: false,
    search: false,
    hiddenToggle: false,
    gitStatusChip: false,
  },
  useFileViewerSource: useProjectFileSource,
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
