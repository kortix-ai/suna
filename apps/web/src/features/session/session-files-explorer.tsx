'use client';
import { FilesStoreProvider, useFilesStore } from '@/features/files';
import { SandboxFileExplorer } from '@/features/files/sandbox-file-explorer';
import { SessionDiffViewer } from '@/features/session/session-diff-viewer';
import {
  deriveExplorerMode,
  explorerViewForMode,
  initialExplorerNonce,
} from '@/features/session/session-files-explorer-logic';
import { getSessionFilesStore } from '@/features/session/session-files-store-registry';
import {
  SessionVersionHeader,
  type SessionPanelMode,
} from '@/features/session/session-version-header';
import { useSessionBrowserStore } from '@/stores/session-browser-store';
import { useEffect, useRef, useState } from 'react';

/**
 * Session side-panel "Files" surface.
 *
 * An elegant version header frames the screen as a standalone copy of the
 * project's main version, with two plain tabs:
 *   • All files (default) — the SAME Drive-style explorer the /files page
 *                uses ({@link DriveExplorer}), pointed at the live sandbox
 *                via {@link sandboxExplorerSource} (writable, searchable).
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
  projectId,
  projectSessionId,
  ephemeral = false,
  initialMode = 'files',
}: {
  chatSessionId?: string;
  projectId?: string;
  projectSessionId?: string;
  /**
   * Which tab an ephemeral mount lands on. Ignored when not `ephemeral` —
   * a persisted mount takes its mode from `viewBySession`, which is the whole
   * point of that mode. Lets a caller that means "show me the changes" say so
   * without writing shared state only Advanced reads.
   */
  initialMode?: SessionPanelMode;
  /**
   * True when this mount is a transient detail layer (Easy panel's "Files"
   * drill-in) rather than Advanced mode's canonical Files tab. Advanced is
   * the sole owner of `viewBySession` (its resume point) and of replaying
   * `fileOpenBySession` on mount; an ephemeral mount must not touch either —
   * see {@link SessionFilesExplorerInner} for what changes.
   */
  ephemeral?: boolean;
} = {}) {
  const store = chatSessionId ? getSessionFilesStore(chatSessionId) : undefined;
  return (
    <FilesStoreProvider store={store}>
      <SessionFilesExplorerInner
        chatSessionId={chatSessionId}
        projectId={projectId}
        projectSessionId={projectSessionId}
        ephemeral={ephemeral}
        initialMode={initialMode}
      />
    </FilesStoreProvider>
  );
}

function SessionFilesExplorerInner({
  chatSessionId,
  projectId,
  projectSessionId,
  ephemeral = false,
  initialMode = 'files',
}: {
  chatSessionId?: string;
  projectId?: string;
  projectSessionId?: string;
  initialMode?: SessionPanelMode;
  ephemeral?: boolean;
}) {
  const rawView = useSessionBrowserStore((s) =>
    chatSessionId ? s.viewBySession[chatSessionId] : undefined,
  );
  const setView = useSessionBrowserStore((s) => s.setView);

  // Honor "reveal this file" requests from chat (clicking a file path). The
  // request lives in the shared panel store; we apply it to THIS provider's
  // scoped FilesStore. The nonce guard makes repeated clicks re-open the file.
  const fileOpenReq = useSessionBrowserStore((s) =>
    chatSessionId ? s.fileOpenBySession[chatSessionId] : undefined,
  );
  const openFile = useFilesStore((s) => s.openFile);
  // Non-ephemeral (Advanced) mounts are the sole consumer of the request, so
  // they start at 0 and replay whatever is already pending — that's how
  // clicking a file path in chat reveals the file. Ephemeral (Easy) mounts
  // share the request with Easy's own file-preview effect, which already
  // consumed it; seed from the request's CURRENT nonce (read once, not via
  // the reactive selector, so this doesn't itself trigger a re-render) so a
  // leftover request isn't replayed into the explorer on open.
  const lastNonce = useRef(
    initialExplorerNonce(
      ephemeral,
      chatSessionId
        ? useSessionBrowserStore.getState().fileOpenBySession[chatSessionId]?.nonce
        : undefined,
    ),
  );
  useEffect(() => {
    if (!fileOpenReq || fileOpenReq.nonce === lastNonce.current) return;
    lastNonce.current = fileOpenReq.nonce;
    openFile(fileOpenReq.path, fileOpenReq.line);
  }, [fileOpenReq, openFile]);

  // The `files` panel-view value == Changes; anything else on this surface ==
  // All files. Default (the `explorer` value) is All files.
  //
  // Ephemeral mounts (Easy's detail layer) must not own or mutate
  // `viewBySession` — that's Advanced's persisted resume point, and Easy has
  // no tab strip it could even apply to — so the mode lives in local state
  // and never round-trips through the store.
  const [localMode, setLocalMode] = useState<SessionPanelMode>(initialMode);
  const mode = deriveExplorerMode(ephemeral, localMode, rawView);
  const onModeChange = (next: SessionPanelMode) => {
    if (ephemeral) {
      setLocalMode(next);
      return;
    }
    if (!chatSessionId) return;
    setView(chatSessionId, explorerViewForMode(next));
  };

  const showDiff = mode === 'changes' && !!chatSessionId;

  return (
    <div className="flex h-full flex-col">
      <SessionVersionHeader chatSessionId={chatSessionId} mode={mode} onModeChange={onModeChange} />
      <div className="min-h-0 flex-1">
        {showDiff ? (
          <SessionDiffViewer sessionId={chatSessionId!} />
        ) : (
          <SandboxFileExplorer
            embedded
            shareContext={
              projectId && projectSessionId ? { projectId, sessionId: projectSessionId } : undefined
            }
          />
        )}
      </div>
    </div>
  );
}
