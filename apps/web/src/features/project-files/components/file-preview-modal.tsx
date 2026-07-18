'use client';

import { STATUS_TEXT } from '@/components/ui/status';
import { useFilesStore } from '@/features/file-browser/store/files-store';
import { FilePreviewModal as BaseFilePreviewModal } from '@/features/file-viewer';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
import { useFileExplorerSource } from '../explorer-source';
import { FileHistoryPopoverContent } from './file-history-popover';
import { getFileIcon } from './file-icon';

/**
 * File preview modal for the shared Drive explorer. Thin wrapper over the
 * shared <FilePreviewModal> that supplies the explorer store, the injected
 * data source and the checkpoint history popover. The per-file git-status
 * chip renders only for sources that expose live status (sandbox), never for
 * read-only ref views.
 */
export function FilePreviewModal({
  embedded = false,
  shareContext,
}: {
  embedded?: boolean;
  shareContext?: { projectId: string; sessionId: string };
} = {}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const selectedFilePath = useFilesStore((s) => s.selectedFilePath);
  const panelMode = useFilesStore((s) => s.panelMode);
  const goBackToBrowser = useFilesStore((s) => s.goBackToBrowser);
  const nextFile = useFilesStore((s) => s.nextFile);
  const prevFile = useFilesStore((s) => s.prevFile);
  const filePathList = useFilesStore((s) => s.filePathList);
  const currentFileIndex = useFilesStore((s) => s.currentFileIndex);

  const explorer = useFileExplorerSource();
  const source = explorer.useFileViewerSource();

  // Git state for THIS file — shows what changed in this version.
  const { data: gitStatuses } = explorer.useGitStatus();
  const fileStatus = useMemo(() => {
    if (!explorer.capabilities.gitStatusChip) return null;
    if (!selectedFilePath || !gitStatuses) return null;
    const rel = selectedFilePath.replace(/^\/workspace\//, '');
    return gitStatuses.find((s) => s.path === rel || s.path === selectedFilePath) ?? null;
  }, [explorer.capabilities.gitStatusChip, selectedFilePath, gitStatuses]);

  const statusSlot = fileStatus ? (
    <span
      className={cn(
        'bg-muted/60 flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize',
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
      source={source}
      HistoryContent={FileHistoryPopoverContent}
      renderFileIcon={(name) =>
        getFileIcon(name, {
          className: 'h-4 w-4 shrink-0 text-muted-foreground',
          variant: 'monochrome',
        })
      }
      statusSlot={statusSlot}
      shareContext={shareContext}
      embedded={embedded}
      historyLabel={tI18nHardcoded.raw(
        'autoFeaturesProjectFilesComponentsFilePreviewModalJsxAttrHistoryLabel0736a6ed',
      )}
    />
  );
}
