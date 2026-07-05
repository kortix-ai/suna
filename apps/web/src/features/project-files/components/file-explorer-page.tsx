'use client';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { FolderOpen } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useProjectContext } from '../context';
import { useChangeRequests } from '../hooks/use-change-requests';
import { useDirectoryDownload } from '../hooks/use-directory-download';
import { useFileCopy, useFileDelete, useFileMkdir, useFileRename } from '../hooks/use-file-mutations';
import { useFilesStore } from '../store/files-store';
import type { FileNode } from '../types';
import { ChangeRequestDetailDialog } from './change-request-detail-dialog';
import { ChangeRequestsPanel } from './change-requests-panel';
import { CheckpointsPanel } from './checkpoints-panel';
import { DriveExplorer } from './drive-explorer';
import { OpenChangeRequestDialog } from './open-change-request-dialog';
import { DriveGridView } from './drive-grid-view';
import { DriveHeader } from './drive-header';
import { DriveListView } from './drive-list-view';
import { DriveToolbar } from './drive-toolbar';
import { FileHistoryPopoverContent } from './file-history-popover';
import { FilePreviewModal } from './file-preview-modal';
import { useFileEventInvalidation } from '../hooks';

type RightPanel = 'checkpoints' | 'change-requests' | null;

/**
 * Project git-ref file explorer page (customize → Files). Thin wrapper over
 * the shared <DriveExplorer> that adds the git-only chrome: version selector,
 * checkpoints panel, change-request panel + dialogs. Requires both a
 * <ProjectFilesProvider> and a git-ref <FileExplorerSourceProvider>.
 */
export function FileExplorerPage() {
  const projectCtx = useProjectContext();
  const projectId = projectCtx?.projectId ?? '';

  const projectRef = projectCtx?.ref ?? '';

  useFileEventInvalidation();

  const { data: files, isLoading, error, refetch: refetchFiles } = useFileList(currentPath);

  const { data: gitStatuses } = useGitStatus();
  const gitStatusMap = useMemo(() => buildGitStatusMap(gitStatuses), [gitStatuses]);

  const deleteMutation = useFileDelete();
  const mkdirMutation = useFileMkdir();
  const renameMutation = useFileRename();
  const copyMutation = useFileCopy();

  const deleteButtonRef = useRef<HTMLButtonElement>(null);

  const [deleteTarget, setDeleteTarget] = useState<FileNode | null>(null);

  const { downloadDir, isDownloading: isDirDownloading } = useDirectoryDownload();

  const [showSkeleton, setShowSkeleton] = useState(false);
  useEffect(() => {
    if (isLoading) {
      const timer = setTimeout(() => setShowSkeleton(true), 200);
      return () => clearTimeout(timer);
    }
    setShowSkeleton(false);
  }, [isLoading]);

  const isRootPath = currentPath === '/' || currentPath === '.' || currentPath === '';
  const normalizedCurrentPath = isRootPath ? '' : currentPath.replace(/\/$/, '');

  const ELEVATED_DIRS = new Set(['.kortix', '.opencode']);

  const { elevatedDirs, dirs, fileItems } = useMemo(() => {
    if (!files)
      return {
        elevatedDirs: [] as FileNode[],
        dirs: [] as FileNode[],
        fileItems: [] as FileNode[],
      };

    const sortFn = (a: FileNode, b: FileNode) => {
      let cmp = 0;
      switch (sortBy) {
        case 'name':
          cmp = a.name.localeCompare(b.name);
          break;
        case 'type': {
          const extA = a.name.includes('.') ? a.name.split('.').pop() || '' : '';
          const extB = b.name.includes('.') ? b.name.split('.').pop() || '' : '';
          cmp = extA.localeCompare(extB);
          if (cmp === 0) cmp = a.name.localeCompare(b.name);
          break;
        }
        case 'modified':
        case 'size':
          cmp = a.name.localeCompare(b.name);
          break;
      }
      return sortOrder === 'desc' ? -cmp : cmp;
    };

    const allDirs = files.filter((f) => f.type === 'directory');
    const elevatedDirs = allDirs
      .filter((f) => ELEVATED_DIRS.has(f.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    const dirs = allDirs.filter((f) => !ELEVATED_DIRS.has(f.name)).sort(sortFn);
    const fileItems = files.filter((f) => f.type === 'file').sort(sortFn);
    return { elevatedDirs, dirs, fileItems };
  }, [files, sortBy, sortOrder]);

  const handleNavigateToDir = useCallback(
    (node: FileNode) => {
      navigateToPath(node.path);
    },
    [navigateToPath],
  );

  const handleOpenFile = useCallback(
    (node: FileNode) => {
      const allFiles = fileItems.map((f) => f.path);
      const index = allFiles.indexOf(node.path);
      openFileWithList(node.path, allFiles, Math.max(0, index));
    },
    [fileItems, openFileWithList],
  );

  const handlePreviewFile = useCallback(
    (node: FileNode) => {
      const allFiles = fileItems.map((f) => f.path);
      const index = allFiles.indexOf(node.path);
      openFileWithList(node.path, allFiles, Math.max(0, index));
    },
    [fileItems, openFileWithList],
  );

  const handleDownload = useCallback(
    async (node: FileNode) => {
      if (!projectId || !projectRef) return;
      try {
        await downloadFile(projectId, projectRef, node.path, node.name);
        successToast(`Downloaded ${node.name}`);
      } catch {
        errorToast(`Failed to download ${node.name}`);
      }
    },
    [projectId, projectRef],
  );

  const handleDownloadDir = useCallback(
    (node: FileNode) => {
      downloadDir(node.path, node.name);
    },
    [downloadDir],
  );

  const handleRename = useCallback(
    async (node: FileNode, newName: string) => {
      if (!newName || newName === node.name) return;
      const parentPath = node.path.substring(0, node.path.lastIndexOf('/'));
      const newPath = parentPath ? `${parentPath}/${newName}` : newName;
      try {
        await renameMutation.mutateAsync({ from: node.path, to: newPath });
        successToast(`Renamed to ${newName}`);
      } catch (err) {
        errorToast(`Failed to rename: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
    [renameMutation],
  );

  const handleDelete = useCallback((node: FileNode) => {
    setDeleteTarget(node);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync({ filePath: deleteTarget.path });
      successToast(`Deleted ${deleteTarget.name}`);
    } catch (err) {
      errorToast(`Failed to delete: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteTarget, deleteMutation]);

  const handleHistory = useCallback((node: FileNode) => {
    setHistoryPopoverPath(node.path);
  }, []);

  const handleCopy = useCallback(
    (node: FileNode) => {
      copyToClipboard(node.path, node.name, node.type);
      successToast(`Copied "${node.name}" to clipboard`);
    },
    [copyToClipboard],
  );

  const handleCut = useCallback(
    (node: FileNode) => {
      cutToClipboard(node.path, node.name, node.type);
      successToast(`Cut "${node.name}" to clipboard`);
    },
    [cutToClipboard],
  );

  const handleDropMove = useCallback(
    async (sourcePath: string, targetDirPath: string) => {
      const sourceName = sourcePath.split('/').pop() || '';
      const destPath = targetDirPath ? `${targetDirPath}/${sourceName}` : sourceName;
      if (sourcePath === destPath) return;
      try {
        await renameMutation.mutateAsync({ from: sourcePath, to: destPath });
        successToast(`Moved "${sourceName}"`);
      } catch (err) {
        errorToast(`Failed to move: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
    [renameMutation],
  );

  const handlePaste = useCallback(async () => {
    if (!clipboard) return;
    const destDir = normalizedCurrentPath;
    let destName = clipboard.name;

    if (files) {
      const existingNames = new Set(files.map((f) => f.name.toLowerCase()));
      if (existingNames.has(destName.toLowerCase())) {
        if (clipboard.operation === 'copy') {
          const ext = destName.includes('.') ? destName.substring(destName.lastIndexOf('.')) : '';
          const baseName = ext ? destName.substring(0, destName.lastIndexOf('.')) : destName;
          let counter = 0;
          let candidate = `${baseName} (copy)${ext}`;
          while (existingNames.has(candidate.toLowerCase())) {
            counter++;
            candidate = `${baseName} (copy ${counter + 1})${ext}`;
          }
          destName = candidate;
        } else {
          const sourceDir = clipboard.path.substring(0, clipboard.path.lastIndexOf('/')) || '.';
          const normalizedSourceDir = sourceDir === '' ? '.' : sourceDir;
          const normalizedDestDir = destDir === '' ? '.' : destDir;
          if (normalizedSourceDir === normalizedDestDir) {
            errorToast('Item is already in this directory');
            return;
          }
        }
      }
    }

    const destPath = destDir ? `${destDir}/${destName}` : destName;

    try {
      if (clipboard.operation === 'copy') {
        if (clipboard.type === 'file') {
          await copyMutation.mutateAsync({ sourcePath: clipboard.path, destPath });
          successToast(`Copied "${clipboard.name}" here`);
        } else {
          await mkdirMutation.mutateAsync({ dirPath: destPath });
          successToast(`Created copy of folder "${clipboard.name}" here (empty)`);
        }
      } else {
        await renameMutation.mutateAsync({ from: clipboard.path, to: destPath });
        successToast(`Moved "${clipboard.name}" here`);
        clearClipboard();
      }
    } catch (err) {
      errorToast(`Failed to paste: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [
    clipboard,
    normalizedCurrentPath,
    files,
    copyMutation,
    renameMutation,
    mkdirMutation,
    clearClipboard,
  ]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
        return;
      if ((e.metaKey || e.ctrlKey) && e.key === 'v' && clipboard) {
        e.preventDefault();
        handlePaste();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [clipboard, handlePaste]);

  const [historyPopoverPath, setHistoryPopoverPath] = useState<string | null>(null);

  type RightPanel = 'history' | 'proposed-changes' | null;
  const [rightPanel, setRightPanel] = useState<RightPanel>(null);
  const [createdCrId, setCreatedCrId] = useState<string | null>(null);
  const toggleRightPanel = (panel: RightPanel) =>
    setRightPanel((current) => (current === panel ? null : panel));

  const openCrCountQuery = useChangeRequests('open', { refetchInterval: 10_000 });
  const openCrCount = openCrCountQuery.data?.change_requests.length ?? 0;

  // Deep link: /…?cr=<id> opens the change-request detail dialog once.
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    const cr = searchParams.get('cr');
    if (!cr) return;
    setCreatedCrId(cr);
    const params = new URLSearchParams(searchParams.toString());
    params.delete('cr');
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [searchParams, pathname, router]);

  return (
    <DriveExplorer
      toolbar={{
        showVersionSelector: true,
        checkpointsToggle: {
          open: rightPanel === 'checkpoints',
          onToggle: () => toggleRightPanel('checkpoints'),
        },
        changeRequestsToggle: {
          open: rightPanel === 'change-requests',
          onToggle: () => toggleRightPanel('change-requests'),
          openCount: openCrCount,
        },
        openChangeRequestAction: {
          onClick: () => setOpenCrDialogShown(true),
        },
      }}
      panels={
        <>
          <CheckpointsPanel
            open={rightPanel === 'checkpoints'}
            onClose={() => setRightPanel(null)}
          />
          <ChangeRequestsPanel
            open={rightPanel === 'change-requests'}
            onClose={() => setRightPanel(null)}
          />
        </>
      }
    >
      <OpenChangeRequestDialog
        open={openCrDialogShown}
        onOpenChange={setOpenCrDialogShown}
        projectId={projectId}
        defaultBranch={defaultBranchForCrs}
        initialHeadRef={canOpenChangeRequest ? activeRefForCrs : undefined}
        onCreated={(crId) => {
          setRightPanel('change-requests');
          setCreatedCrId(crId);
        }}
      />

      <ChangeRequestDetailDialog crId={createdCrId} onClose={() => setCreatedCrId(null)} />
    </DriveExplorer>
  );
}
