'use client';

import { FileExplorerPage, FilesStoreProvider } from '@/features/files';
import { useSessionBrowserStore } from '@/stores/session-browser-store';
import {
  SessionVersionHeader,
  type SessionPanelMode,
} from '@/components/session/session-version-header';
import { SessionDiffViewer } from '@/components/session/session-diff-viewer';

/**
 * Session side-panel "Files" surface.
 *
 * An elegant version header frames the screen as a standalone copy of the
 * project's main version, with two plain tabs:
 *   • All files (default) — the full Google-Drive-style explorer the /files
 *                page uses ({@link FileExplorerPage}), pointed at the sandbox.
 *   • Changes (secondary) — the real per-file diff viewer
 *                ({@link SessionDiffViewer}), the same diff UI used elsewhere.
 *
 * The sub-mode is addressable through the shared panel-view store (the `files`
 * view value means "Changes"), so the header chip's "View changes" lands the
 * user straight on the diff while the default stays All files.
 *
 * Wrapped in its own FilesStoreProvider so each session tab keeps independent
 * navigation/view state.
 */
export function SessionFilesExplorer({
  chatSessionId,
}: {
  chatSessionId?: string;
} = {}) {
  return (
    <FilesStoreProvider>
      <SessionFilesExplorerInner chatSessionId={chatSessionId} />
    </FilesStoreProvider>
  );
}

function SessionFilesExplorerInner({ chatSessionId }: { chatSessionId?: string }) {
  const rawView = useSessionBrowserStore((s) =>
    chatSessionId ? s.viewBySession[chatSessionId] : undefined,
  );
  const setView = useSessionBrowserStore((s) => s.setView);

  // The `files` panel-view value == Changes; anything else on this surface ==
  // All files. Default (the `explorer` value) is All files.
  const mode: SessionPanelMode = rawView === 'files' ? 'changes' : 'files';
  const onModeChange = (next: SessionPanelMode) => {
    if (!chatSessionId) return;
    setView(chatSessionId, next === 'changes' ? 'files' : 'explorer');
  };

  const showDiff = mode === 'changes' && !!chatSessionId;

  return (
    <div className="flex h-full flex-col">
      <SessionVersionHeader
        chatSessionId={chatSessionId}
        mode={mode}
        onModeChange={onModeChange}
      />
      <div className="min-h-0 flex-1">
        {showDiff ? <SessionDiffViewer sessionId={chatSessionId!} /> : <FileExplorerPage />}
      </div>
    </div>
  );
}
