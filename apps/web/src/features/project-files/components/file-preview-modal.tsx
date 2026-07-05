'use client';

import { FilePreviewModal as BaseFilePreviewModal } from '@/features/file-viewer';
import { useTranslations } from 'next-intl';
import { useProjectFileSource } from '../file-source';
import { useFilesStore } from '@/features/file-browser/store/files-store';
import { FileHistoryPopoverContent } from './file-history-popover';
import { getFileIcon } from './file-icon';

/**
 * Project git-ref file preview modal. Thin wrapper over the shared
 * <FilePreviewModal> that supplies the project store, the ref-scoped data
 * source and the checkpoint history popover. No git-status chip / open-in-tab
 * (this is a read-only ref view).
 */
export function FilePreviewModal() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const selectedFilePath = useFilesStore((s) => s.selectedFilePath);
  const panelMode = useFilesStore((s) => s.panelMode);
  const goBackToBrowser = useFilesStore((s) => s.goBackToBrowser);
  const nextFile = useFilesStore((s) => s.nextFile);
  const prevFile = useFilesStore((s) => s.prevFile);
  const filePathList = useFilesStore((s) => s.filePathList);
  const currentFileIndex = useFilesStore((s) => s.currentFileIndex);
  const source = useProjectFileSource();

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
      historyLabel={tI18nHardcoded.raw(
        'autoFeaturesProjectFilesComponentsFilePreviewModalJsxAttrHistoryLabel0736a6ed',
      )}
    />
  );
}
