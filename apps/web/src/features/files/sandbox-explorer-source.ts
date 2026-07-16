'use client';

import type { FileExplorerSource } from '@/features/project-files/explorer-source';
import { downloadFile } from './api/opencode-files';
import { workspaceFileSource } from './file-source';
import {
  useFileEventInvalidation,
  useFileSearch,
  useGitStatus,
  useServerHealth,
} from './hooks';
import { useDirectoryDownload } from './hooks/use-directory-download';
import { useFileCommitDiff, useFileHistory } from './hooks/use-file-history';
import { useFileList } from './hooks/use-file-list';
import {
  useFileCopy,
  useFileCreate,
  useFileDelete,
  useFileMkdir,
  useFileRename,
  useFileUpload,
} from './hooks/use-file-mutations';

/**
 * Live-sandbox explorer source: writable, searchable, health-gated. Reads the
 * active sandbox's OpenCode server (via the server store), so it is a module
 * constant — no provider needed beyond the explorer's own store.
 */
export const sandboxExplorerSource: FileExplorerSource = {
  capabilities: {
    write: true,
    search: true,
    hiddenToggle: true,
    gitStatusChip: true,
  },
  useFileViewerSource: () => workspaceFileSource,
  useFileList: (dirPath) => {
    const { data: health } = useServerHealth();
    return useFileList(dirPath, { enabled: health?.healthy === true });
  },
  useGitStatus: () => {
    const { data: health } = useServerHealth();
    return useGitStatus({ enabled: health?.healthy === true });
  },
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
  useDownloadFile: () => downloadFile,
};
