'use client';

import { Drawer, DrawerContent } from '../primitives/drawer';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../primitives/resizable';
import { BrowserPanel } from '../browser/browser-panel';
import { SessionDetailPanel } from '../session/panel/session-detail-panel';
import { SessionOutcomesBridge } from '../session/outcomes/session-outcomes-bridge';
import { SessionPanelProvider } from '../session/panel/session-panel-provider';
import { MobileToolDrawer } from '../session/panel/mobile-tool-drawer';
import { ProviderPoolDraftBoundary } from '../session/overrides/provider-pool-draft-context';
import { SessionAuditPanel } from '../session/panel/session-audit-panel';
import { SessionFilesExplorer } from '../session/panel/session-files-explorer';
import { PanelHeaderSwitcher } from '../session/panel/session-panel-header';
import { SessionTerminalPanel } from '../terminal/session-terminal-panel';
import { SessionWallpaperLayerContext } from '../session/panel/session-wallpaper-layer';
import { useSessionPanelLayout } from '../session/panel/use-session-panel-layout';
import {
  useSessionPanelSessionSync,
  useSessionPanelView,
} from '../session/panel/use-session-panel-state';
import { useIsMobile } from '../internal/hooks';
import { cn } from '../lib/utils';
import { useKortixComputerStore } from '../internal/stores/kortix-computer-store';
import {
  SessionPanelView,
  sessionPreviewTabId,
  useSessionBrowserStore,
} from '../internal/stores/session-browser-store';
import type { SessionStartStage } from '@kortix/sdk';
import type { UseSessionResult } from '@kortix/sdk/react';
import { ProjectScope } from '../internal/project-scope';
import { SessionThread } from '../session/thread/session-thread';
import type React from 'react';
import { memo, useCallback, useState } from 'react';

export interface SessionLayoutProps {
  sessionId: string;
  projectId?: string;
  projectSessionId?: string;
  children: React.ReactNode;
  bootStage?: SessionStartStage | null;
  transient?: boolean;
}

type SessionPanelProps = {
  sessionId: string;
  projectId?: string;
  projectSessionId?: string;
  booting: boolean;
  isExpanded: boolean;
  shouldShowPanel: boolean;
} & ReturnType<typeof useSessionPanelView> &
  ReturnType<typeof useSessionPanelLayout> &
  ReturnType<typeof useSessionPanelSurfaces>;

interface SessionSurfaceProps {
  panel: SessionPanelProps;
  children: React.ReactNode;
}

export const SessionLayout = memo(function SessionLayout({
  sessionId,
  projectId,
  projectSessionId,
  children,
  bootStage = null,
  transient = false,
}: SessionLayoutProps) {
  const isMobile = useIsMobile();
  const booting = !!bootStage;

  const { isSidePanelOpen, isExpanded, panelSplit, panelAspect, shouldShowPanel } =
    useSessionPanelSplitState();

  const { isSessionBusy, isEasy, effectiveView, auditPendingCount, togglePanelMode } =
    useSessionPanelView({ sessionId, projectId, projectSessionId, transient, booting });
  useSessionPanelSessionSync({ sessionId, projectSessionId, transient });
  const panels = useSessionPanelLayout({
    sessionId,
    isMobile,
    isExpanded,
    isEasy,
    panelSplit,
    panelAspect,
    shouldShowPanel,
  });
  const panelBody = useSessionPanelBody({
    sessionId,
    projectId,
    projectSessionId,
    isEasy,
    effectiveView,
  });
  const surfaces = useSessionPanelSurfaces({
    sessionId,
    booting,
    isEasy,
    effectiveView,
    auditPendingCount,
    togglePanelMode,
    panelBody,
  });

  const panel = {
    sessionId,
    projectId,
    projectSessionId,
    booting,
    ...panels,
    isSessionBusy,
    effectiveView,
    auditPendingCount,
    togglePanelMode,
    isExpanded,
    isEasy,
    shouldShowPanel,
    ...surfaces,
  };

  if (isMobile) {
    return withPanelProvider(
      panel,
      <MobileSessionLayout panel={panel}>{children}</MobileSessionLayout>,
    );
  }

  return withPanelProvider(
    panel,
    <DesktopSessionLayout panel={panel}>{children}</DesktopSessionLayout>,
  );
});

function useSessionPanelSplitState() {
  // Use individual selectors to avoid re-rendering on unrelated store changes
  // (e.g. pendingToolNavIndex, focusedToolCallId). Destructuring the whole
  // store subscribes to ALL properties and causes unnecessary re-renders for
  // every open session tab.
  const isSidePanelOpen = useKortixComputerStore((s) => s.isSidePanelOpen);
  const isExpanded = useKortixComputerStore((s) => s.isExpanded);
  // Easy mode only — the side panel's requested share of the split (70 for a
  // presentation deliverable, 50 for the terminal layer, null for the default
  // card column). See the store's doc comment; Advanced ignores it.
  const panelSplit = useKortixComputerStore((s) => s.panelSplit);
  // Easy mode only — the open document's own width/height, published by the
  // renderer that decoded it. Outranks `panelSplit`: a portrait PDF knows its
  // shape, and a file extension only ever guessed at it. See `resolveSideSize`.
  const panelAspect = useKortixComputerStore((s) => s.panelAspect);
  // `detailOpen` is no longer read here. It gated the resize grip while Easy
  // mode's fixed-width card home lived in this panel; with the cards moved to
  // the floating overlay an open panel is always showing a resizable detail.
  // The store still publishes it (the provider writes it) — nothing in this
  // layout needs to ask any more.

  const shouldShowPanel = isSidePanelOpen;

  return { isSidePanelOpen, isExpanded, panelSplit, panelAspect, shouldShowPanel };
}

function useSessionPanelSurfaces({
  sessionId,
  booting,
  isEasy,
  effectiveView,
  auditPendingCount,
  togglePanelMode,
  panelBody,
}: {
  sessionId: string;
  booting: boolean;
  isEasy: boolean;
  effectiveView: SessionPanelView;
  auditPendingCount: number;
  togglePanelMode: () => void;
  panelBody: React.ReactNode;
}) {
  const isSidePanelOpen = useKortixComputerStore((s) => s.isSidePanelOpen);
  const setIsSidePanelOpen = useKortixComputerStore((s) => s.setIsSidePanelOpen);
  const setPanelView = useSessionBrowserStore((s) => s.setView);

  const handleTogglePanel = useCallback(() => {
    setIsSidePanelOpen(!isSidePanelOpen);
  }, [isSidePanelOpen, setIsSidePanelOpen]);

  const panelHeader = (
    <PanelHeaderSwitcher
      view={effectiveView}
      onChangeView={(v) => setPanelView(sessionId, v)}
      isSidePanelOpen={isSidePanelOpen}
      onTogglePanel={handleTogglePanel}
      auditBadge={auditPendingCount}
      onToggleMode={togglePanelMode}
    />
  );

  // While booting there is no header bar, and the body is the detail shell in
  // its boot state (`SessionDetailPanel` reads `booting` from the provider): a
  // Terminal/Browser/Files card wears its real chrome over the wake status, and
  // with no card open the panel is the wake status alone. The runtime-coupled
  // bodies (PTY, preview frame, file listing) mount only once booted.
  //
  // Easy mode has no header either: it is the three cards and nothing else. No
  // title, no view tabs, no mode button, no border. The mode is switched from
  // Settings → Appearance and the command palette. Nothing here is a dead end:
  // the detail card carries its own close button and Escape, and ⌘I / Ctrl+I
  // closes the right side from anywhere. The two differ on purpose: the card's
  // own close DISCARDS the detail (it is done with), while ⌘I only puts it
  // away — press it again and the same detail comes back.
  const effectivePanelHeader = booting || isEasy ? null : panelHeader;
  const effectivePanelBody = booting ? <SessionDetailPanel /> : panelBody;

  return { effectivePanelHeader, effectivePanelBody };
}

function useSessionPanelBody({
  sessionId,
  projectId,
  projectSessionId,
  isEasy,
  effectiveView,
}: {
  sessionId: string;
  projectId?: string;
  projectSessionId?: string;
  isEasy: boolean;
  effectiveView: SessionPanelView;
}) {
  const showBrowser = !isEasy && effectiveView === 'browser';
  const showExplorer = !isEasy && effectiveView === 'explorer';
  const showTerminal = !isEasy && effectiveView === 'terminal';
  const showAudit = !isEasy && effectiveView === 'audit';

  const [terminalActivated, setTerminalActivated] = useState(false);
  if (showTerminal && !terminalActivated) setTerminalActivated(true);

  const [browserActivated, setBrowserActivated] = useState(false);
  if (showBrowser && !browserActivated) setBrowserActivated(true);

  // Easy mode's body is the detail shell and nothing else — the cards moved to
  // the floating overlay over the chat. The Advanced branches below are kept
  // intact (Advanced is disabled, not deleted) and are unreachable while
  // `isEasy` is forced true.
  const swappableBody = showAudit ? (
    <SessionAuditPanel projectId={projectId} projectSessionId={projectSessionId} />
  ) : showExplorer ? (
    <SessionFilesExplorer
      chatSessionId={sessionId}
      projectId={projectId}
      projectSessionId={projectSessionId}
    />
  ) : (
    <SessionDetailPanel />
  );
  const panelBody = (
    <div className="relative h-full w-full">
      {terminalActivated && (
        <div className={cn('absolute inset-0', !showTerminal && 'hidden')}>
          <SessionTerminalPanel
            sessionId={sessionId}
            projectId={projectId}
            projectSessionId={projectSessionId ?? undefined}
            hidden={!showTerminal}
          />
        </div>
      )}
      {browserActivated && (
        <div className={cn('absolute inset-0', !showBrowser && 'hidden')}>
          <BrowserPanel
            tabId={sessionPreviewTabId(sessionId)}
            projectId={projectId}
            projectSessionId={projectSessionId}
          />
        </div>
      )}
      <div className={cn('absolute inset-0', (showTerminal || showBrowser) && 'hidden')}>
        {swappableBody}
      </div>
    </div>
  );

  return panelBody;
}

// The provider wraps BOTH panels. It has to: the floating overlay renders
// inside `children` (the chat, in the main resizable panel) and every detail
// renders in the side panel, and a card row clicked in one opens a detail in
// the other. See `session-panel-provider.tsx`.
const withPanelProvider = (
  {
    sessionId,
    projectId,
    projectSessionId,
    isSessionBusy,
    booting,
  }: Pick<
    SessionPanelProps,
    'sessionId' | 'projectId' | 'projectSessionId' | 'isSessionBusy' | 'booting'
  >,
  node: React.ReactNode,
) => (
  <ProviderPoolDraftBoundary identity={`${projectId}/${projectSessionId ?? sessionId}`}>
    <SessionPanelProvider
      sessionId={sessionId}
      isSessionBusy={isSessionBusy}
      projectId={projectId}
      projectSessionId={projectSessionId}
      booting={booting}
    >
      <SessionOutcomesBridge key={`${projectId}/${projectSessionId ?? sessionId}`}>{node}</SessionOutcomesBridge>
    </SessionPanelProvider>
  </ProviderPoolDraftBoundary>
);

function MobileSessionLayout({ panel, children }: SessionSurfaceProps) {
  const { sessionId, projectId, projectSessionId, effectivePanelHeader, effectivePanelBody } =
    panel;
  const isSidePanelOpen = useKortixComputerStore((s) => s.isSidePanelOpen);
  const setIsSidePanelOpen = useKortixComputerStore((s) => s.setIsSidePanelOpen);
  const isExpanded = useKortixComputerStore((s) => s.isExpanded);
  const toggleExpanded = useKortixComputerStore((s) => s.toggleExpanded);

  // Mobile hosts BOTH surfaces in one drawer — there is no room beside the chat
  // for a column, so the cards are the drawer's home view and a detail stacks
  // as its own drawer on top (see `SessionDetailPanel`'s mobile branch). The
  // two states stay independent everywhere else; here they simply share a
  // container, so the drawer is up whenever either one is, and dismissing it
  // has to put both down or the next open would replay a surface the user just
  // swiped away.
  const isActionPanelOpen = useKortixComputerStore((s) => s.isActionPanelOpen);
  const setIsActionPanelOpen = useKortixComputerStore((s) => s.setIsActionPanelOpen);
  const shouldShowMobilePanel = isSidePanelOpen || isActionPanelOpen;
  const handleSidePanelClose = useCallback(() => {
    if (isExpanded) toggleExpanded();
    setIsSidePanelOpen(false);
  }, [setIsSidePanelOpen, isExpanded, toggleExpanded]);
  const handleMobilePanelClose = useCallback(() => {
    handleSidePanelClose();
    setIsActionPanelOpen(false);
  }, [handleSidePanelClose, setIsActionPanelOpen]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      <Drawer
        open={shouldShowMobilePanel}
        onOpenChange={(open) => {
          if (!open) handleMobilePanelClose();
        }}
      >
        {/* Easy mode's tool surfaces (Terminal, Browser, Files) render as
            layers INSIDE this one sheet rather than as their own stacked
            drawers, so it has to be tall enough to hold them, and a grabber
            would sit above their own headers. Advanced keeps the shorter,
            grabbed sheet — there the tools are tabs in the panel body. */}
        <DrawerContent
          bar={false}
          className={cn('flex flex-col overflow-hidden p-0', 'h-[95dvh] max-h-[95dvh]')}
        >
          {effectivePanelHeader}
          <div className="min-h-0 flex-1 overflow-hidden">{effectivePanelBody}</div>
        </DrawerContent>
      </Drawer>
      {/* Dev tools (header / palette) open here — a peer of the panel
          sheet, never inside it. Closing lands back on chat. */}
      <MobileToolDrawer
        sessionId={sessionId}
        projectId={projectId}
        projectSessionId={projectSessionId}
      />
    </div>
  );
}

function DesktopSessionLayout({ panel, children }: SessionSurfaceProps) {
  const { mainPanelRef, panelGroupRef, isAnimating, isEasy, isExpanded, shouldShowPanel } = panel;

  const [wallpaperLayer, setWallpaperLayer] = useState<HTMLDivElement | null>(null);

  return (
    <SessionWallpaperLayerContext.Provider value={wallpaperLayer}>
      {/* `overflow-clip` (not -hidden) on the layout wrappers below: hidden
          boxes still accept a programmatic scrollLeft — a focus() aimed at a
          mid-animation (translated) panel layer scrolled them sideways and the
          layout stuck there, with no scrollbar to undo it. Clip makes them
          categorically unscrollable; the visual clipping is identical. */}
      <div
        className="bg-background relative flex h-full flex-col overflow-clip"
        data-testid="session-layout"
      >
        <div
          ref={panelGroupRef}
          className={cn(
            'relative flex min-h-0 flex-1 overflow-clip',
            // Fullscreen detail: the shell's floating sidebar toggle sits at
            // z-30 in the same stacking context this wrapper competes in, and
            // this wrapper is the panel subtree's stacking-context root — so
            // the whole panel is capped at z-10 and the toggle bleeds through
            // over the detail's toolbar. Elevate to z-[35] while expanded:
            // above the toggle (30) and the sidebar edge strip (30), still
            // below the sidebar's hover-peek flyout (40) and fixed overlays.
            isExpanded ? 'z-[35]' : 'z-10',
          )}
        >
          <ResizablePanelGroup
            direction="horizontal"
            className="h-full gap-0 bg-transparent"
            style={{ transition: 'none' }}
          >
            <ResizablePanel
              ref={mainPanelRef}
              defaultSize={shouldShowPanel ? (isEasy ? 65 : 50) : 100}
              minSize={shouldShowPanel ? (isAnimating ? 0 : isExpanded ? 0 : 30) : 100}
              maxSize={shouldShowPanel ? (isAnimating ? 100 : isExpanded ? 0 : 65) : 100}
              collapsible={isExpanded || isAnimating}
              className={cn(
                'relative flex w-full flex-col overflow-hidden bg-transparent transition-[padding] duration-300 ease-out',
                isExpanded && !isAnimating && 'pointer-events-none opacity-0',
              )}
            >
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
            </ResizablePanel>

            {/* Draggable whenever the panel is open (`handleEnabled`); the
                grip pill only SHOWS on Easy mode's card home once a detail or
                the terminal is up (`handleVisible`, published by EasyPanel) —
                but the seam itself stays live there, with an invisible
                12px-wide hit strip (the `after:` element; the handle element
                itself is w-0 so the panels stay flush) and a hover/drag
                reveal so the affordance is discoverable. */}
            <SessionPanelHandle panel={panel} />

            <SessionPanelSide panel={panel} />
          </ResizablePanelGroup>
        </div>
      </div>
    </SessionWallpaperLayerContext.Provider>
  );
}

function SessionPanelHandle({ panel }: { panel: SessionPanelProps }) {
  const { isExpanded, shouldShowPanel } = panel;

  // The resize handle. FUNCTIONAL whenever there's a split to drag — panel
  // open, not fullscreen.
  //
  // VISIBLE used to be stricter, hiding the grip while Easy mode showed its
  // fixed-width card home. That home no longer lives here: with the cards moved
  // to the floating overlay, an open panel is always showing a detail, which is
  // always resizable. The two states collapse into one.
  const handleEnabled = shouldShowPanel && !isExpanded;
  const handleVisible = handleEnabled;

  return (
    <ResizableHandle
      withHandle={handleEnabled}
      disabled={!handleEnabled}
      className={cn(
        'z-20 w-0 transition-opacity duration-300',
        'after:absolute after:inset-y-0 after:-left-1.5 after:w-3',
        handleEnabled ? '-right-3' : 'pointer-events-none',
        handleVisible
          ? 'opacity-100'
          : 'opacity-0 hover:opacity-100 data-[resize-handle-active]:opacity-100',
      )}
    />
  );
}

function SessionPanelSide({ panel }: { panel: SessionPanelProps }) {
  const {
    sidePanelRef,
    shouldShowPanel,
    isAnimating,
    isExpanded,
    isEasy,
    effectivePanelHeader,
    effectivePanelBody,
  } = panel;

  return (
    <ResizablePanel
      ref={sidePanelRef}
      defaultSize={shouldShowPanel ? (isEasy ? 35 : 50) : 0}
      minSize={shouldShowPanel ? (isAnimating ? 0 : isExpanded ? 100 : 35) : 0}
      maxSize={shouldShowPanel ? (isAnimating ? 100 : isExpanded ? 100 : 70) : 0}
      collapsible={!isExpanded || isAnimating}
      className={cn('bg-background relative overflow-hidden', !shouldShowPanel && 'hidden')}
    >
      <div className={cn('bg-background h-full transition-[padding] duration-300 ease-out')}>
        <div
          className={cn(
            'border-border flex h-full min-h-0 w-full min-w-0 flex-col overflow-clip',
            // Easy mode is chrome-free — the cards carry their own
            // borders, so a panel border would just box a box.
            !isEasy && 'border-l',
          )}
        >
          {effectivePanelHeader}
          <div className="min-h-0 flex-1 overflow-clip">{effectivePanelBody}</div>
        </div>
      </div>
    </ResizablePanel>
  );
}

export interface SessionWorkspaceProps {
  /** The result of `useSession(projectId, sessionId)` from `@kortix/sdk/react`. */
  session: UseSessionResult;
  /** The conversation column. Default: `<SessionThread session={session} />`. */
  children?: React.ReactNode;
  /** Passed to the default thread: hide its header (title, panel buttons, menu). */
  hideHeader?: boolean;
  /** Passed to the default thread: no composer. */
  readOnly?: boolean;
  className?: string;
}

/**
 * The whole session screen apps/web renders: the thread, and the resizable side
 * panel its actions open (files, the file viewer, browser, terminal, changes,
 * audit). On a phone the panel is a sheet. The parent sets the size.
 *
 *   const session = useSession(projectId, sessionId);
 *   return <SessionWorkspace session={session} />;
 *
 * Until the runtime has a session id, the thread shows its own starting state
 * and no panel is mounted.
 */
export function SessionWorkspace({
  session,
  children,
  hideHeader,
  readOnly,
  className,
}: SessionWorkspaceProps) {
  const { projectId, sessionId, runtimeSessionId } = session;
  const thread = children ?? (
    <SessionThread session={session} hideHeader={hideHeader} readOnly={readOnly} />
  );
  return (
    <ProjectScope projectId={projectId} sessionId={sessionId}>
      <div
        data-slot="session-workspace"
        className={cn('relative flex h-full min-h-0 w-full flex-col', className)}
      >
        {runtimeSessionId ? (
          <SessionLayout
            key={runtimeSessionId}
            sessionId={runtimeSessionId}
            projectId={projectId}
            projectSessionId={sessionId}
          >
            {thread}
          </SessionLayout>
        ) : (
          thread
        )}
      </div>
    </ProjectScope>
  );
}
