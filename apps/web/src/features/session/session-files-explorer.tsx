'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FilesStoreProvider, useFilesStore } from '@/features/files';
import { SandboxFileExplorer } from '@/features/files/sandbox-file-explorer';
import {
  useOpenChangeRequest,
  useSessionBaseRef,
  useSessionChanges,
} from '@/features/session/session-changes-shared';
import { SessionDiffViewer } from '@/features/session/session-diff-viewer';
import {
  deriveExplorerMode,
  explorerViewForMode,
  initialExplorerNonce,
  type SessionPanelMode,
} from '@/features/session/session-files-explorer-logic';
import { getSessionFilesStore } from '@/features/session/session-files-store-registry';
import { useSessionBrowserStore } from '@/stores/session-browser-store';
import { ArrowRightIcon } from '@phosphor-icons/react';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

export type { SessionPanelMode };

/**
 * The session panel's Files surface: two tabs, two panels.
 *
 *   • All files — the Drive-style explorer pointed at the live sandbox.
 *   • Changes   — the diff for everything this session changed.
 *
 * It is a plain Radix `Tabs`. It used to be a hand-rolled tablist in a
 * `session-version-header.tsx` that reimplemented what `tabs.tsx` already
 * does — roving `tabIndex`, arrow/Home/End key handling, an absolutely
 * positioned underline `<span>`, and `panelId`/`sessionVersionTabId` threaded
 * through three components (and into the explorer, as `contentPanel`) to hand
 * -wire `aria-controls` and `aria-labelledby`. `TabsList type="underline"`
 * plus two `TabsContent` is all of that, so the header file and the
 * `contentPanel` prop are gone.
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
   * Which tab an ephemeral mount lands on. Ignored when not `ephemeral` — a
   * persisted mount takes its mode from `viewBySession`, which is the whole
   * point of that mode.
   */
  initialMode?: SessionPanelMode;
  /**
   * True when this mount is a transient detail layer (Easy panel's "Files"
   * drill-in) rather than Advanced mode's canonical Files tab. Advanced is the
   * sole owner of `viewBySession` (its resume point) and of replaying
   * `fileOpenBySession` on mount; an ephemeral mount must not touch either.
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
  // The git branch == the ROUTE session id; the chat session id is passed in.
  const { id: routeProjectId, sessionId: gitSessionId } = useParams<{
    id: string;
    sessionId: string;
  }>();

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
  const [initialNonce] = useState(() =>
    initialExplorerNonce(
      ephemeral,
      chatSessionId
        ? useSessionBrowserStore.getState().fileOpenBySession[chatSessionId]?.nonce
        : undefined,
    ),
  );
  const lastNonce = useRef(initialNonce);
  useEffect(() => {
    if (!fileOpenReq || fileOpenReq.nonce === lastNonce.current) return;
    lastNonce.current = fileOpenReq.nonce;
    openFile(fileOpenReq.path, fileOpenReq.line);
  }, [fileOpenReq, openFile]);

  // Ephemeral mounts (Easy's detail layer) must not own or mutate
  // `viewBySession` — that is Advanced's persisted resume point — so their
  // mode lives in local state and never round-trips through the store.
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

  // The SAME query the diff panel renders — one array, so the tab's count and
  // the panel below it cannot contradict each other.
  const { count: changedCount } = useSessionChanges();
  const baseRef = useSessionBaseRef(routeProjectId, gitSessionId);
  const { asking, openChangeRequest } = useOpenChangeRequest(chatSessionId, baseRef);
  const versionId = gitSessionId?.slice(0, 8);

  return (
    <Tabs
      value={mode}
      onValueChange={(next) => onModeChange(next as SessionPanelMode)}
      className="flex h-full min-h-0 flex-col gap-0"
    >
      <div className="border-border/60 flex h-11 shrink-0 items-center gap-3 border-b px-2">
        {/* The list draws the rule; this row already has one, so it keeps only
            the sliding underline. Triggers carry no padding so the first tab's
            text starts on the same 8px edge as the panel below it. */}
        <TabsList type="underline" className="h-11 gap-5 border-b-0">
          <TabsTrigger value="files" className="w-fit flex-none px-0">
            All files
          </TabsTrigger>
          <TabsTrigger value="changes" className="w-fit flex-none gap-1.5 px-0">
            Changes
            {changedCount > 0 && (
              <Badge variant="secondary" size="tabular">
                {changedCount}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {mode === 'changes' && changedCount > 0 && (
          <Button
            size="sm"
            className="ml-auto shrink-0 gap-1.5 active:scale-[0.96]"
            onClick={openChangeRequest}
            disabled={asking}
          >
            {asking ? <Loading className="size-3.5 shrink-0" /> : null}
            Propose changes
          </Button>
        )}
      </div>

      <TabsContent value="files" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <SandboxFileExplorer
          embedded
          shareContext={
            projectId && projectSessionId ? { projectId, sessionId: projectSessionId } : undefined
          }
        />
      </TabsContent>

      <TabsContent value="changes" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Where this work is and where it is going. Both are names, so both
            are chips; the only words are the part neither chip can show. */}
        <div className="flex flex-wrap items-center gap-1.5 px-2 pt-2">
          {versionId && (
            <>
              <Badge variant="outline" size="sm" className="font-mono">
                {versionId}
              </Badge>
              <ArrowRightIcon aria-hidden className="text-muted-foreground/40 size-3 shrink-0" />
              {/* The arrow is decorative, so the relationship is stated once
                  for anyone who cannot see it. */}
              <span className="sr-only">into</span>
            </>
          )}
          <Badge variant="outline" size="sm" className="max-w-32 min-w-0 font-mono">
            <span className="truncate">{baseRef}</span>
          </Badge>
          <span className="text-muted-foreground text-xs">not applied yet</span>
        </div>
        <div className="min-h-0 flex-1">
          <SessionDiffViewer />
        </div>
      </TabsContent>
    </Tabs>
  );
}
