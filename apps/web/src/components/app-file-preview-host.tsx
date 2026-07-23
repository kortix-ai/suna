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
 * `FilePreviewModal` requires an icon renderer and a `HistoryContent`, but
 * this surface has no explorer above it — no source with real git-commit
 * history to back one. `HistoryContent` gets a local stub (see below) rather
 * than the live, explorer-backed one, for the same reason there is no share
 * context here: sharing and history are both scoped to a surface that owns a
 * file source, which is exactly what this surface lacks. `PublicShareLinkButton`
 * is omitted rather than disabled, matching how the session viewers treat
 * unavailable actions.
 */

import { FilePreviewModal } from '@/features/file-viewer';
import { workspaceFileSource } from '@/features/files/file-source';
import { getFileIcon } from '@/features/project-files';
import { useFilePreviewStore } from '@/stores/file-preview-store';

const NO_OP = () => {};

/**
 * `HistoryContent` is required by `FilePreviewModalProps`, but real history
 * needs a file source with git-commit backing (`useFileHistory` /
 * `useFileCommitDiff`), which only the explorer surfaces carry. This host
 * mounts with no explorer above it, so it stays a stub rather than pulling in
 * an explorer source just to satisfy the type — live history belongs to the
 * explorer surfaces, not to this panel-less fallback.
 */
function HistoryContent(_props: { filePath: string; onClose: () => void }) {
  return (
    <div className="flex w-[420px] max-w-[calc(100vw-2rem)] flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="text-muted-foreground text-xs">Version history isn&apos;t available here.</p>
    </div>
  );
}

export function AppFilePreviewHost() {
  const isOpen = useFilePreviewStore((s) => s.isOpen);
  const filePath = useFilePreviewStore((s) => s.filePath);
  const closePreview = useFilePreviewStore((s) => s.closePreview);

  if (!isOpen || !filePath) return null;

  return (
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
