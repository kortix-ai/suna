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
import { useFilesStore } from '@/features/file-browser/store/files-store';
import type { FileNode } from '@/features/file-browser/types';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { FolderOpen } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { downloadFile } from '../api/opencode-files';
import { useProjectContext } from '../context';
import { buildGitStatusMap, useFileEventInvalidation, useFileList, useGitStatus } from '../hooks';
import { useChangeRequests } from '../hooks/use-change-requests';
import { useDirectoryDownload } from '../hooks/use-directory-download';
import {
  useFileCopy,
  useFileDelete,
  useFileMkdir,
  useFileRename,
} from '../hooks/use-file-mutations';
import { ChangeRequestDetailDialog } from './change-request-detail-dialog';
import { ChangeRequestsPanel } from './change-requests-panel';
import { CheckpointsPanel } from './checkpoints-panel';
import { DriveGridView } from './drive-grid-view';
import { DriveHeader } from './drive-header';
import { DriveListView } from './drive-list-view';
import { DriveToolbar } from './drive-toolbar';
import { FileHistoryPopoverContent } from './file-history-popover';
import { FilePreviewModal } from './file-preview-modal';

export function FileExplorerPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const currentPath = useFilesStore((s) => s.currentPath);
  const navigateToPath = useFilesStore((s) => s.navigateToPath);
  const viewMode = useFilesStore((s) => s.viewMode);
  const sortBy = useFilesStore((s) => s.sortBy);
  const sortOrder = useFilesStore((s) => s.sortOrder);
  const openFileWithList = useFilesStore((s) => s.openFileWithList);

  const clipboard = useFilesStore((s) => s.clipboard);
  const copyToClipboard = useFilesStore((s) => s.copyToClipboard);
  const cutToClipboard = useFilesStore((s) => s.cutToClipboard);
  const clearClipboard = useFilesStore((s) => s.clearClipboard);

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

  const isEmpty =
    !isLoading &&
    !error &&
    Boolean(files) &&
    elevatedDirs.length === 0 &&
    dirs.length === 0 &&
    fileItems.length === 0;

  return (
    <div className="bg-background relative flex h-full flex-col">
      <DriveHeader
        historyToggle={{
          open: rightPanel === 'history',
          onToggle: () => toggleRightPanel('history'),
        }}
        reviewsToggle={{
          open: rightPanel === 'proposed-changes',
          onToggle: () => toggleRightPanel('proposed-changes'),
          openCount: openCrCount,
        }}
      />

      <DriveToolbar
        showVersionSelector
        onDownloadDir={() => {
          const dirName = isRootPath
            ? 'workspace'
            : currentPath.split('/').filter(Boolean).pop() || 'directory';
          const dirPath = isRootPath ? '/workspace' : currentPath;
          downloadDir(dirPath, dirName);
        }}
        isDownloading={isDirDownloading(isRootPath ? '/workspace' : currentPath)}
        onRefresh={() => refetchFiles()}
      />

      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 overflow-y-auto">
          {isLoading && showSkeleton && (
            <div className="animate-in fade-in-0 p-4 duration-200">
              {viewMode === 'grid' ? (
                <div className="space-y-6">
                  <div>
                    <Skeleton className="mb-3 h-4 w-16" />
                    <div
                      className="grid gap-2"
                      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}
                    >
                      {Array.from({ length: 6 }).map((_, i) => (
                        <Skeleton key={`f${i}`} className="h-10 rounded-lg" />
                      ))}
                    </div>
                  </div>
                  <div>
                    <Skeleton className="mb-3 h-4 w-12" />
                    <div
                      className="grid gap-2.5"
                      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}
                    >
                      {Array.from({ length: 8 }).map((_, i) => (
                        <Skeleton key={`fi${i}`} className="h-[138px] rounded-lg" />
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-1">
                  {Array.from({ length: 10 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full rounded" />
                  ))}
                </div>
              )}
            </div>
          )}

          {error && !isLoading && (
            <ErrorState
              title={tHardcodedUi.raw(
                'featuresProjectFilesComponentsFileExplorerPage.line658JsxTextFailedToLoadFiles',
              )}
              description={error instanceof Error ? error.message : 'Unknown error'}
              action={
                <Button variant="outline" size="sm" onClick={() => refetchFiles()}>
                  Retry
                </Button>
              }
            />
          )}

          {isEmpty && (
            <EmptyState
              icon={FolderOpen}
              title={tHardcodedUi.raw(
                'featuresProjectFilesComponentsDriveListView.line396JsxTextThisFolderIsEmpty',
              )}
              description={tHardcodedUi.raw(
                'featuresProjectFilesComponentsDriveListView.line398JsxTextNoFilesOrSubfoldersAtThisPathIn',
              )}
            />
          )}

          {!isLoading && !error && files && !isEmpty && (
            <>
              {viewMode === 'grid' ? (
                <DriveGridView
                  elevatedDirs={elevatedDirs}
                  dirs={dirs}
                  files={fileItems}
                  onNavigateToDir={handleNavigateToDir}
                  onOpenFile={handleOpenFile}
                  onPreviewFile={handlePreviewFile}
                  onDownload={handleDownload}
                  onDownloadDir={handleDownloadDir}
                  onRename={handleRename}
                  onDelete={handleDelete}
                  onHistory={handleHistory}
                  onCopy={handleCopy}
                  onCut={handleCut}
                  onDropMove={handleDropMove}
                  gitStatusMap={gitStatusMap}
                  clipboardPath={clipboard?.path}
                  clipboardOperation={clipboard?.operation}
                  isDirDownloading={isDirDownloading}
                  readOnly
                />
              ) : (
                <DriveListView
                  elevatedDirs={elevatedDirs}
                  dirs={dirs}
                  files={fileItems}
                  onNavigateToDir={handleNavigateToDir}
                  onOpenFile={handleOpenFile}
                  onPreviewFile={handlePreviewFile}
                  onDownload={handleDownload}
                  onDownloadDir={handleDownloadDir}
                  onRename={handleRename}
                  onDelete={handleDelete}
                  onHistory={handleHistory}
                  onCopy={handleCopy}
                  onCut={handleCut}
                  onDropMove={handleDropMove}
                  gitStatusMap={gitStatusMap}
                  clipboardPath={clipboard?.path}
                  clipboardOperation={clipboard?.operation}
                  isDirDownloading={isDirDownloading}
                  readOnly
                />
              )}
            </>
          )}
        </div>

        <CheckpointsPanel open={rightPanel === 'history'} onClose={() => setRightPanel(null)} />

        <ChangeRequestsPanel
          open={rightPanel === 'proposed-changes'}
          onClose={() => setRightPanel(null)}
        />
      </div>

      <ChangeRequestDetailDialog crId={createdCrId} onClose={() => setCreatedCrId(null)} />

      <FilePreviewModal />

      {historyPopoverPath && (
        <div className="bg-popover border-border animate-in slide-in-from-bottom-4 fade-in-0 fixed right-4 bottom-4 z-50 overflow-hidden rounded-md border shadow-2xl duration-200">
          <FileHistoryPopoverContent
            filePath={historyPopoverPath}
            onClose={() => setHistoryPopoverPath(null)}
          />
        </div>
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent
          className="sm:max-w-md"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            deleteButtonRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleteTarget?.type === 'directory' ? 'folder' : 'file'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {tHardcodedUi.raw(
                'featuresProjectFilesComponentsFileExplorerPage.line806JsxTextAreYouSureYouWantToDelete',
              )}{' '}
              <span className="text-foreground font-semibold">
                {tHardcodedUi.raw(
                  'featuresProjectFilesComponentsFileExplorerPage.line807JsxTextQuot',
                )}
                {deleteTarget?.name}
                {tHardcodedUi.raw(
                  'featuresProjectFilesComponentsFileExplorerPage.line807JsxTextQuot32c14d98',
                )}
              </span>
              {tHardcodedUi.raw(
                'featuresProjectFilesComponentsFileExplorerPage.line807JsxTextThisActionCannotBeUndone',
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              ref={deleteButtonRef}
              onClick={(e) => {
                e.preventDefault();
                confirmDelete();
              }}
              disabled={deleteMutation.isPending}
              className="bg-destructive hover:bg-destructive/90 text-white"
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
