'use client';

/**
 * The file preview for a page with no session side panel.
 *
 * `openPreview` (`file-preview-store`) is what every file open in the UI calls:
 * a tool row's Preview, a file chip, a clickable path, inline code. Inside
 * `SessionWorkspace` it opens the file in the side panel. Anywhere else it sets
 * `isOpen`, and this dialog shows the file.
 *
 * Mount `FilePreviewHost` (`./file-preview-host`) once where such opens can happen. `SessionThread`
 * mounts it already (through `SessionPanelFallback`); apps/web mounts it at the
 * app root for its dashboard and project pages. It needs a QueryClient and,
 * for sandbox files, a mounted `useSession`.
 */

import { useTranslations } from '../i18n';
import { useFilePreviewStore } from '../internal/stores/file-preview-store';
import { getFileIcon } from './project';
import { workspaceFileSource } from './runtime/file-source';
import { FilePreviewModal } from './viewer/file-preview-modal';

const NO_OP = () => {};

/**
 * Version history needs a file source with git commits behind it, which only
 * the explorer surfaces have. This dialog has no explorer above it.
 */
function HistoryContent(_props: { filePath: string; onClose: () => void }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="flex w-[420px] max-w-[calc(100vw-2rem)] flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="text-muted-foreground text-xs">{tI18nComplete.raw('texte5789ce1b021')}</p>
    </div>
  );
}

/** The dialog body. Renders nothing while the store is closed. */
export function FilePreviewDialog() {
  const isOpen = useFilePreviewStore((s) => s.isOpen);
  const filePath = useFilePreviewStore((s) => s.filePath);
  const closePreview = useFilePreviewStore((s) => s.closePreview);

  if (!isOpen || !filePath) return null;

  return (
    <FilePreviewModal
      selectedFilePath={filePath}
      panelMode="viewer"
      // One file: prev/next stay hidden (the modal derives that from the list length).
      filePathList={[filePath]}
      currentFileIndex={0}
      onClose={closePreview}
      onNext={NO_OP}
      onPrev={NO_OP}
      source={workspaceFileSource}
      HistoryContent={HistoryContent}
      renderFileIcon={(name) =>
        getFileIcon(name, {
          className: 'h-4 w-4 shrink-0 text-muted-foreground',
          variant: 'monochrome',
        })
      }
    />
  );
}
