'use client';

/**
 * Mobile dev tools — Terminal / Browser / Files / Audit in their OWN
 * top-level bottom sheet, driven by `mobileToolView` in the kortix-computer
 * store (set by `openSessionQuickView` on mobile viewports).
 *
 * Deliberately NOT the Easy panel's detail flow: routing a tool through the
 * panel meant opening the panel sheet first, stacking a second sheet over it,
 * and landing the user on the Easy home when they closed the tool. This
 * drawer is a peer of the panel sheet — it opens over chat and closes back to
 * chat, and the panel's own state never moves.
 *
 * Bodies are the same self-contained surfaces Advanced mode's panel tabs
 * mount (`SessionTerminalPanel`, `BrowserPanel`, `SessionFilesExplorer`,
 * `SessionAuditPanel`), so both panel modes get identical tools here. vaul
 * unmounts the content on close, so the terminal reconnects per open — the
 * tradeoff every mobile drawer in this feature already accepts.
 */

import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { BrowserPanel } from '@/features/session/action-panel/browser-panel';
import { CloseButton } from '@/features/session/action-panel/easy/detail-view';
import { SessionAuditPanel } from '@/features/session/session-audit-panel';
import { SessionFilesExplorer } from '@/features/session/session-files-explorer';
import { SessionTerminalPanel } from '@/features/session/session-terminal-panel';
import { useKortixComputerStore, type QuickView } from '@/stores/kortix-computer-store';
import { sessionPreviewTabId } from '@/stores/session-browser-store';
import {
  FolderOpenIcon,
  GlobeIcon,
  ScrollIcon,
  TerminalWindowIcon,
  type Icon,
} from '@phosphor-icons/react';

const TOOL_META: Record<QuickView, { label: string; Icon: Icon }> = {
  terminal: { label: 'Terminal', Icon: TerminalWindowIcon },
  browser: { label: 'Browser', Icon: GlobeIcon },
  files: { label: 'Files', Icon: FolderOpenIcon },
  audit: { label: 'Audit', Icon: ScrollIcon },
};

export function MobileToolDrawer({
  sessionId,
  workspaceId,
  workspaceSessionId,
}: {
  sessionId: string;
  workspaceId?: string;
  workspaceSessionId?: string;
}) {
  const view = useKortixComputerStore((s) => s.mobileToolView);
  const closeMobileTool = useKortixComputerStore((s) => s.closeMobileTool);
  const meta = view ? TOOL_META[view] : null;

  return (
    <Drawer open={view !== null} onOpenChange={(next) => !next && closeMobileTool()}>
      <DrawerContent
        bar={false}
        className="flex h-[95dvh] max-h-[95dvh] min-h-[95dvh] flex-col overflow-hidden p-0"
      >
        <DrawerHeader className="shrink-0 px-4 py-3 text-left">
          <DrawerTitle className="flex items-center justify-between gap-2 text-base">
            <span className="flex items-center gap-2.5">
              {meta && <meta.Icon className="text-muted-foreground size-4 shrink-0" />}
              {meta?.label}
            </span>
            <CloseButton onClose={closeMobileTool} />
          </DrawerTitle>
        </DrawerHeader>
        <div className="min-h-0 flex-1 overflow-hidden">
          {view === 'terminal' && (
            <SessionTerminalPanel sessionId={sessionId} workspaceSessionId={workspaceSessionId} />
          )}
          {view === 'browser' && (
            <BrowserPanel
              tabId={sessionPreviewTabId(sessionId)}
              workspaceId={workspaceId}
              workspaceSessionId={workspaceSessionId}
            />
          )}
          {view === 'files' && (
            <SessionFilesExplorer
              chatSessionId={sessionId}
              workspaceId={workspaceId}
              workspaceSessionId={workspaceSessionId}
            />
          )}
          {view === 'audit' && (
            <SessionAuditPanel workspaceId={workspaceId} workspaceSessionId={workspaceSessionId} />
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
