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

import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '../../primitives/drawer';
import { BrowserPanel } from '../../browser/browser-panel';
import { CloseButton } from './easy/detail-view';
import { SessionAuditPanel } from './session-audit-panel';
import { SessionRemindersPanel } from './session-reminders-panel';
import { SessionFilesExplorer } from './session-files-explorer';
import { SessionTerminalPanel } from '../../terminal/session-terminal-panel';
import { SessionBootStatus } from '../status/session-starting-loader';
import { useOptionalSessionPanel } from './session-panel-provider';
import { useLocalizedUiCatalog } from '../../i18n/ui-catalog/use-localized-ui-catalog';
import { useKortixComputerStore, type QuickView } from '../../internal/stores/kortix-computer-store';
import { sessionPreviewTabId } from '../../internal/stores/session-browser-store';
import {
  AlarmIcon,
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
  reminders: { label: 'Reminders', Icon: AlarmIcon },
};

export function MobileToolDrawer({
  sessionId,
  projectId,
  projectSessionId,
}: {
  sessionId: string;
  projectId?: string;
  projectSessionId?: string;
}) {
  const view = useKortixComputerStore((s) => s.mobileToolView);
  const closeMobileTool = useKortixComputerStore((s) => s.closeMobileTool);
  const toolMeta = useLocalizedUiCatalog(TOOL_META);
  const meta = view ? toolMeta[view] : null;
  // Terminal, Browser and Files need the computer: while it boots, the drawer
  // shows the wake status in their place.
  const booting =
    !!useOptionalSessionPanel()?.booting &&
    (view === 'terminal' || view === 'browser' || view === 'files');

  return (
    <Drawer open={view !== null} onOpenChange={(next) => !next && closeMobileTool()}>
      <DrawerContent className="flex h-[95dvh] max-h-[95dvh] min-h-[95dvh] flex-col overflow-hidden p-0">
        <DrawerHeader className="shrink-0 px-4 py-3 text-left">
          <DrawerTitle className="flex items-center justify-between gap-2 text-base">
            <span className="flex items-center gap-2.5">
              {meta && <meta.Icon className="text-muted-foreground size-4 shrink-0" />}
              {meta?.label}
            </span>
            <CloseButton onClose={closeMobileTool} variant="ghost" />
          </DrawerTitle>
        </DrawerHeader>
        <div className="min-h-0 flex-1 overflow-hidden">
          {booting && <SessionBootStatus projectId={projectId} sessionId={projectSessionId} />}
          {!booting && view === 'terminal' && (
            <SessionTerminalPanel
              sessionId={sessionId}
              projectId={projectId}
              projectSessionId={projectSessionId}
            />
          )}
          {!booting && view === 'browser' && (
            <BrowserPanel
              tabId={sessionPreviewTabId(sessionId)}
              projectId={projectId}
              projectSessionId={projectSessionId}
            />
          )}
          {!booting && view === 'files' && (
            <SessionFilesExplorer
              chatSessionId={sessionId}
              projectId={projectId}
              projectSessionId={projectSessionId}
            />
          )}
          {view === 'audit' && (
            <SessionAuditPanel projectId={projectId} projectSessionId={projectSessionId} />
          )}
          {view === 'reminders' && (
            <div className="h-full overflow-y-auto p-4">
              <SessionRemindersPanel projectId={projectId} projectSessionId={projectSessionId} />
            </div>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
