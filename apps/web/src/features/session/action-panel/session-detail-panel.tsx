'use client';

/**
 * `SessionDetailPanel` — the right-hand panel's entire body.
 *
 * One shell, one card, four views. Terminal, browser, files and file preview
 * all render inside `DetailLayer`'s card frame; none of them gets a surface of
 * its own. The terminal used to be the exception — a hand-copied second frame
 * living beside the shell, which is what made it read as its own sidebar — and
 * it now arrives as `DetailLayer`'s `persistentLayer`, mounted once so its PTY
 * WebSocket survives every close.
 *
 * Desktop has no home view behind the card: the Outputs/Context/Preview cards
 * moved to the floating overlay over the chat. The panel is content-driven, so
 * an empty home is never on screen — `closeDetail` closes the panel itself.
 *
 * Mobile keeps the old composition. There the panel is already a bottom drawer
 * and the overlay does not exist, so the cards remain the drawer's home view
 * and the terminal comes up as its own drawer (a second horizontal layer inside
 * a bottom sheet would be a maze).
 */

import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { SessionTerminalPanel } from '@/features/session/session-terminal-panel';
import { useIsMobile } from '@/hooks/utils';
import { TerminalIcon } from '@phosphor-icons/react';
import { EasyPanel } from './easy/easy-panel';
import { CloseButton, DetailLayer, type PersistentLayer } from './easy/detail-view';
import { useOptionalSessionPanel } from './session-panel-provider';

export function SessionDetailPanel() {
  const isMobile = useIsMobile();
  const panel = useOptionalSessionPanel();
  if (!panel) return null;

  const { detail, closeDetail, terminalOpen, terminalSwap, closeTerminal, sessionId } = panel;
  const { workspaceSessionId } = panel;

  const terminalLayer: PersistentLayer = {
    open: terminalOpen,
    swap: terminalSwap,
    title: 'Terminal',
    icon: <TerminalIcon className="text-muted-foreground size-4 shrink-0" />,
    onClose: closeTerminal,
    body: (
      <SessionTerminalPanel
        sessionId={sessionId}
        workspaceSessionId={workspaceSessionId}
        hidden={!terminalOpen}
      />
    ),
  };

  if (isMobile) {
    return (
      <div className="relative h-full w-full">
        <DetailLayer detail={detail} onBack={closeDetail} isMobile>
          <div className="h-full overflow-auto p-3">
            <EasyPanel />
          </div>
        </DetailLayer>

        {/* vaul unmounts `DrawerContent` on close, so the shell reconnects on
            every open — the tradeoff mobile has always accepted; there is no
            room for a persistent absolutely positioned layer inside a bottom
            sheet. */}
        <Drawer open={terminalOpen} onOpenChange={(next) => !next && closeTerminal()}>
          <DrawerContent
            bar={false}
            className="flex h-[95dvh] max-h-[95dvh] flex-col overflow-hidden p-0"
          >
            <DrawerHeader className="shrink-0 px-4 py-3 text-left">
              <DrawerTitle className="flex items-center justify-between gap-2 text-base">
                <span className="flex items-center gap-2.5">
                  <TerminalIcon className="text-muted-foreground size-4 shrink-0" />
                  Terminal
                </span>
                <CloseButton onClose={closeTerminal} />
              </DrawerTitle>
            </DrawerHeader>
            <div className="min-h-0 flex-1 overflow-hidden">
              <SessionTerminalPanel sessionId={sessionId} workspaceSessionId={workspaceSessionId} />
            </div>
          </DrawerContent>
        </Drawer>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <DetailLayer
        detail={detail}
        onBack={closeDetail}
        isMobile={false}
        persistentLayer={terminalLayer}
      />
    </div>
  );
}
