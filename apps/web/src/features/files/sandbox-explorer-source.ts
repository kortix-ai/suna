'use client';

import type { FileExplorerSource } from '@/features/project-files/explorer-source';
import { useProjectFileSource as useMirrorFileSource } from '@/features/project-files/file-source';
import { useFileList as useMirrorFileList } from '@/features/project-files/hooks/use-file-list';
import { downloadFile } from './api/runtime-files';
import { workspaceFileSource } from './file-source';
import { useFileEventInvalidation, useFileSearch, useGitStatus, useServerHealth } from './hooks';
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
  /**
   * Where the preview modal reads a file's BYTES from.
   *
   * It has to follow the listing. Opening the gate over a parked box means the
   * user can now click a file, and the sandbox reader answers the same
   * `503 sandbox_not_ready` — which `use-file-content` turns into a 3s
   * `refetchInterval` that, against a box only a SEND can wake, never ends.
   * Serving the listing from the mirror while still reading bytes from the dead
   * daemon would just move the forever-spinner from the panel into the viewer.
   */
  useFileViewerSource: () => {
    const { parked } = useServerHealth();
    const mirror = useMirrorFileSource();
    return parked ? mirror : workspaceFileSource;
  },
  /**
   * The listing, from whichever source can actually answer.
   *
   * Box up: the daemon inside it — the live working tree, writable, showing
   * uncommitted edits. Box PARKED: the daemon is unreachable and no read may
   * wake it, so this reads the project's bare git mirror at the session's own
   * branch instead (the branch name IS the session id). Verified against a real
   * parked Platinum box: the daemon answers `503 sandbox_not_ready` in 2ms
   * while the mirror returns the tree in 33ms.
   *
   * The mirror is best-effort — `createRemoteSessionBranch` pushes the branch in
   * the background and records a failure in session metadata — so it can come
   * back empty. `DriveExplorer` treats "parked and empty" as idle rather than as
   * an empty folder, which is the one case this must not state as fact.
   *
   * Both hooks run every render; only one is ever enabled.
   */
  useFileList: (dirPath) => {
    const { data: health, parked } = useServerHealth();
    const live = useFileList(dirPath, { enabled: !parked && health?.healthy === true });
    const mirror = useMirrorFileList(dirPath, { enabled: parked });
    return parked ? mirror : live;
  },
  useReadinessParked: () => useServerHealth().parked,
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
