'use client';

import { useMemo } from 'react';
import { STATUS_TEXT } from '@/components/ui/status';
import { FilePreviewModal as BaseFilePreviewModal } from '@/features/file-viewer';
import { cn } from '@/lib/utils';
import { useFilesStore } from '../store/files-store';
import { useGitStatus } from '../hooks/use-git-status';
import { workspaceFileSource } from '../file-source';
import { FileHistoryPopoverContent } from './file-history-popover';
import { getFileIcon } from './file-icon';

/**
 * Live-workspace file preview modal. Thin wrapper over the shared
 * <FilePreviewModal> that supplies the workspace store, data source, history
 * popover and a git-status chip.
 */
export function FilePreviewModal() {
  const selectedFilePath = useFilesStore((s) => s.selectedFilePath);
  const panelMode = useFilesStore((s) => s.panelMode);
  const goBackToBrowser = useFilesStore((s) => s.goBackToBrowser);
  const nextFile = useFilesStore((s) => s.nextFile);
  const prevFile = useFilesStore((s) => s.prevFile);
  const filePathList = useFilesStore((s) => s.filePathList);
  const currentFileIndex = useFilesStore((s) => s.currentFileIndex);

  // Git state for THIS file — shows what changed in this version.
  const { data: gitStatuses } = useGitStatus();
  const fileStatus = useMemo(() => {
    if (!selectedFilePath || !gitStatuses) return null;
    const rel = selectedFilePath.replace(/^\/workspace\//, '');
    return gitStatuses.find((s) => s.path === rel || s.path === selectedFilePath) ?? null;
  }, [selectedFilePath, gitStatuses]);

  const statusSlot = fileStatus ? (
    <span
      className={cn(
        'flex shrink-0 items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-[11px] font-medium capitalize',
        fileStatus.status === 'added' && STATUS_TEXT.success,
        fileStatus.status === 'deleted' && STATUS_TEXT.destructive,
        fileStatus.status === 'modified' && STATUS_TEXT.warning,
      )}
      title={`This file is ${fileStatus.status} in this version`}
    >
      {fileStatus.status}
      {fileStatus.added > 0 && <span className="tabular-nums">+{fileStatus.added}</span>}
      {fileStatus.removed > 0 && <span className="tabular-nums">−{fileStatus.removed}</span>}
    </span>
  ) : null;

  return (
    <BaseFilePreviewModal
      selectedFilePath={selectedFilePath}
      panelMode={panelMode}
      filePathList={filePathList}
      currentFileIndex={currentFileIndex}
      onClose={goBackToBrowser}
      onNext={nextFile}
      onPrev={prevFile}
      source={workspaceFileSource}
      HistoryContent={FileHistoryPopoverContent}
      renderFileIcon={(name) => getFileIcon(name, { className: 'h-4 w-4 shrink-0', variant: 'monochrome' })}
      statusSlot={statusSlot}
      historyLabel="History"
    />
  );
}
