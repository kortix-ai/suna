'use client';

/**
 * The fallback destination for a file-path click on a surface with NO session
 * side panel — the dashboard, project pages, anywhere outside a session.
 *
 * `file-preview-store` has always had this branch (`set({ isOpen: true })`),
 * but nothing mounted read `isOpen`, so those clicks were silently inert. One
 * host at the app shell resolves it for every such surface at once.
 *
 * Deliberately NOT mounted inside a session: there, `openPreview` returns
 * early into the panel's detail layer and never sets `isOpen`, so this stays
 * closed rather than competing with the panel.
 *
 * `FilePreviewModal` requires a git-history source and an icon renderer —
 * this surface has neither a `<FileExplorerSourceProvider>` nor an explorer
 * of its own above it, so it carries `sandboxExplorerSource` the same way
 * `GridFileCard` does for the identical reason (rendered outside any
 * explorer surface). No share context — sharing is scoped to a project
 * session, which is exactly what these surfaces lack. `PublicShareLinkButton`
 * is omitted rather than disabled, matching how the session viewers treat
 * unavailable actions.
 */

import { FilePreviewModal } from '@/features/file-viewer';
import { workspaceFileSource } from '@/features/files/file-source';
import { sandboxExplorerSource } from '@/features/files/sandbox-explorer-source';
import { FileExplorerSourceProvider, getFileIcon } from '@/features/project-files';
import { FileHistoryPopoverContent } from '@/features/project-files/components/file-history-popover';
import { useFilePreviewStore } from '@/stores/file-preview-store';

const NO_OP = () => {};

export function AppFilePreviewHost() {
  const isOpen = useFilePreviewStore((s) => s.isOpen);
  const filePath = useFilePreviewStore((s) => s.filePath);
  const closePreview = useFilePreviewStore((s) => s.closePreview);

  if (!isOpen || !filePath) return null;

  return (
    <FileExplorerSourceProvider value={sandboxExplorerSource}>
      <FilePreviewModal
        selectedFilePath={filePath}
        panelMode="viewer"
        // One file, so no traversal: prev/next are inert and the modal hides
        // them via its own hasPrev/hasNext derivation from this list's length.
        filePathList={[filePath]}
        currentFileIndex={0}
        onClose={closePreview}
        onNext={NO_OP}
        onPrev={NO_OP}
        source={workspaceFileSource}
        HistoryContent={FileHistoryPopoverContent}
        renderFileIcon={(name) =>
          getFileIcon(name, {
            className: 'h-4 w-4 shrink-0 text-muted-foreground',
            variant: 'monochrome',
          })
        }
      />
    </FileExplorerSourceProvider>
  );
}
