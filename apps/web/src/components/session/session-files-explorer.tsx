'use client';

import { FileExplorerPage, FilesStoreProvider } from '@/features/files';
import { SessionFilesVersionBanner } from '@/components/session/session-files-version-banner';

/**
 * Session side-panel "Files" tab.
 *
 * Renders the exact same Google-Drive-style explorer the /files page uses
 * (`features/files` → FileExplorerPage), pointed at the active session sandbox.
 * Reusing that one component means the session tab shows *all* sandbox files —
 * grid/list, breadcrumbs, sort, the show-dotfiles toggle, search, preview and
 * download — identical to /files, instead of a bespoke cut-down list.
 *
 * Above the explorer sits the version banner: it frames the screen as a
 * standalone, parallel version of the project's main branch, lists the diff,
 * and offers the one way to persist it — open a change request. This makes the
 * Files screen the single place to both browse the version and act on its git
 * state (the separate "Changes" tab is folded in here).
 *
 * Wrapped in its own FilesStoreProvider so each session tab keeps independent
 * navigation/view state and never fights the global /files page or other open
 * sessions. The banner lives inside that provider too, so clicking a changed
 * file opens it in the same preview modal the explorer uses. File opens use the
 * in-place preview modal (`fileOpenMode="preview"`) because the side panel has
 * no workspace tab bar to host a file tab.
 */
export function SessionFilesExplorer({
  chatSessionId,
}: {
  chatSessionId?: string;
} = {}) {
  return (
    <FilesStoreProvider>
      <div className="flex h-full flex-col">
        <SessionFilesVersionBanner chatSessionId={chatSessionId} />
        <div className="min-h-0 flex-1">
          <FileExplorerPage fileOpenMode="preview" />
        </div>
      </div>
    </FilesStoreProvider>
  );
}
