'use client';

import { Button } from '@/components/ui/button';
import { Drawer, DrawerContent } from '@/components/ui/drawer';
import Hint from '@/components/ui/hint';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BrowserPanel } from '@/features/session/action-panel/browser-panel';
import { SessionDetailPanel } from '@/features/session/action-panel/session-detail-panel';
import { SessionPanelProvider } from '@/features/session/action-panel/session-panel-provider';
import {
  aspectChangedWidth,
  resolveSideSize,
} from '@/features/session/action-panel/easy/easy-panel-logic';
import { useDeliverableReadiness } from '@/features/session/action-panel/shared/use-deliverable-readiness';
import { MobileToolDrawer } from '@/features/session/mobile-tool-drawer';
import { SessionAuditPanel } from '@/features/session/session-audit-panel';
import { isPendingAction, useSessionAudit } from '@/features/session/session-audit-shared';
import { SessionFilesExplorer } from '@/features/session/session-files-explorer';
import { SessionStartingLoader } from '@/features/session/session-starting-loader';
import { SessionTerminalPanel } from '@/features/session/session-terminal-panel';
import { SessionWallpaperLayerContext } from '@/features/session/session-wallpaper-layer';
import { useIsMobile } from '@/hooks/utils';
import { cn } from '@/lib/utils';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import {
  normalizeSessionPanelLayoutView,
  SessionPanelView,
  sessionPreviewTabId,
  useSessionBrowserStore,
} from '@/stores/session-browser-store';
import { useTabStore } from '@/stores/tab-store';
import { useUserPreferencesStore } from '@/stores/user-preferences-store';
import type { SessionStartStage } from '@kortix/sdk';
import { useRuntimeMessages, useSessionStateStore } from '@kortix/sdk/react';
import { SidebarSimpleIcon as PanelRight } from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import type React from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as ResizablePrimitive from 'react-resizable-panels';

interface SessionLayoutProps {
  sessionId: string;
  projectId?: string;
  projectSessionId?: string;
  children: React.ReactNode;
  bootStage?: SessionStartStage | null;
  transient?: boolean;
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

  const { data: messages } = useRuntimeMessages(sessionId);

  // Use individual selectors to avoid re-rendering on unrelated store changes
  // (e.g. pendingToolNavIndex, focusedToolCallId). Destructuring the whole
  // store subscribes to ALL properties and causes unnecessary re-renders for
  // every open session tab.
  const isSidePanelOpen = useKortixComputerStore((s) => s.isSidePanelOpen);
  const setIsSidePanelOpen = useKortixComputerStore((s) => s.setIsSidePanelOpen);
  const setActiveSession = useKortixComputerStore((s) => s.setActiveSession);
  const shouldOpenPanel = useKortixComputerStore((s) => s.shouldOpenPanel);
  const clearShouldOpenPanel = useKortixComputerStore((s) => s.clearShouldOpenPanel);
  const isExpanded = useKortixComputerStore((s) => s.isExpanded);
  const toggleExpanded = useKortixComputerStore((s) => s.toggleExpanded);
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

  const handleTogglePanel = useCallback(() => {
    setIsSidePanelOpen(!isSidePanelOpen);
  }, [isSidePanelOpen, setIsSidePanelOpen]);

  const isActiveTab = useTabStore((s) => s.activeTabId === sessionId);

  useEffect(() => {
    if (transient) return;
    if (isActiveTab) {
      setActiveSession(sessionId);
    }
  }, [transient, isActiveTab, sessionId, setActiveSession]);

  const storedPanelView = useSessionBrowserStore((s) => s.viewBySession[sessionId]);
  const panelView = normalizeSessionPanelLayoutView(storedPanelView);
  const setPanelView = useSessionBrowserStore((s) => s.setView);
  const setActivePanelSession = useSessionBrowserStore((s) => s.setActiveSessionId);

  // Existing users' persisted preferences predate this key.
  const panelMode = useUserPreferencesStore((s) => s.preferences.panelMode ?? 'easy');
  const togglePanelMode = useUserPreferencesStore((s) => s.togglePanelMode);
  const isEasy = panelMode === 'easy';

  // The session's own busy/retry status — the exact same signal
  // `session-chat.tsx` reads (as `isServerBusy`) to drive its own working
  // indicator, and the same store `tab-bar.tsx`/`session-list.tsx` read for
  // their busy dots. EasyPanel ORs this with its part-derived running flag so
  // an inter-tool-call gap (assistant text streaming, no tool part active)
  // doesn't read as "finished" — see EasyPanel's `deriveIsRunning`.
  const sessionStatus = useSessionStateStore((s) => s.sessionStatus[sessionId]);
  const isSessionBusy = sessionStatus?.type === 'busy' || sessionStatus?.type === 'retry';

  // W1/W9 — announce finished deliverables and blocked-on-you states while the
  // panel is closed. Headless: writes the ready chip; the header renders it.
  useDeliverableReadiness(sessionId, messages, isSessionBusy);

  // Easy mode is only ever the card home — the other views are engineer
  // surfaces reached through the (hidden) tab strip. Force the view and skip
  // their bodies entirely; `session-browser-store`'s `viewBySession` stays
  // untouched so Advanced mode picks up right where the user left it.
  const effectiveView: SessionPanelView = isEasy ? 'actions' : panelView;
  const showBrowser = !isEasy && effectiveView === 'browser';
  const showExplorer = !isEasy && effectiveView === 'explorer';
  const showTerminal = !isEasy && effectiveView === 'terminal';
  const showAudit = !isEasy && effectiveView === 'audit';

  // Pending-approval count for the "Audit" tab badge. Shares the header nudge's
  // query key so this is one deduped request; skipped while booting/transient.
  const { data: auditData } = useSessionAudit(projectId, projectSessionId, {
    enabled: !transient && !booting && !!projectId && !!projectSessionId,
    silent: true,
  });
  const auditPendingCount = (auditData?.actions ?? []).filter(isPendingAction).length;

  useEffect(() => {
    if (shouldOpenPanel && !isSidePanelOpen) {
      setIsSidePanelOpen(true);
      clearShouldOpenPanel();
    } else if (shouldOpenPanel) {
      clearShouldOpenPanel();
    }
  }, [shouldOpenPanel, isSidePanelOpen, setIsSidePanelOpen, clearShouldOpenPanel]);

  const handleSidePanelClose = useCallback(() => {
    if (isExpanded) toggleExpanded();
    setIsSidePanelOpen(false);
  }, [setIsSidePanelOpen, isExpanded, toggleExpanded]);

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
  const handleMobilePanelClose = useCallback(() => {
    handleSidePanelClose();
    setIsActionPanelOpen(false);
  }, [handleSidePanelClose, setIsActionPanelOpen]);

  const mainPanelRef = useRef<ResizablePrimitive.ImperativePanelHandle>(null);
  const sidePanelRef = useRef<ResizablePrimitive.ImperativePanelHandle>(null);
  const panelGroupRef = useRef<HTMLDivElement>(null);
  // The panel group's own box, in a REF and never in state. The fit is decided
  // once per (document, ratio) pair; a window resize must not redecide it, or
  // the layout would quietly walk away from a divider the user dragged by
  // hand. State here would re-render — and therefore re-fit — on every resize
  // tick, which is precisely the behavior we are refusing.
  const panelBoxRef = useRef<{ width: number; height: number } | null>(null);
  const prevExpandedRef = useRef(isExpanded);
  const prevSplitRef = useRef(panelSplit);
  const prevAspectRef = useRef(panelAspect);

  const [wallpaperLayer, setWallpaperLayer] = useState<HTMLDivElement | null>(null);

  const shouldShowPanel = isSidePanelOpen;

  // The resize handle. FUNCTIONAL whenever there's a split to drag — panel
  // open, not fullscreen.
  //
  // VISIBLE used to be stricter, hiding the grip while Easy mode showed its
  // fixed-width card home. That home no longer lives here: with the cards moved
  // to the floating overlay, an open panel is always showing a detail, which is
  // always resizable. The two states collapse into one.
  const handleEnabled = shouldShowPanel && !isExpanded;
  const handleVisible = handleEnabled;

  const isInTabSystem = useTabStore((s) => !!s.tabs[sessionId]);

  const isVisibleLayout = isInTabSystem ? isActiveTab : true;
  useEffect(() => {
    if (transient) return;
    if (!isVisibleLayout) return;
    setActivePanelSession(sessionId);
    return () => {
      if (useSessionBrowserStore.getState().activeSessionId === sessionId) {
        setActivePanelSession(null);
      }
    };
  }, [transient, isVisibleLayout, sessionId, setActivePanelSession]);
  // ⌘I / Ctrl+I lives on `SessionActionPanelColumn` — it toggles the action
  // panel beside the chat. The right-hand detail panel stays content-driven
  // (no empty-open state, no hotkey).

  const [isAnimating, setIsAnimating] = useState(false);

  const enablePanelTransition = useCallback(() => {
    const el = panelGroupRef.current;
    if (!el) return;
    const panels = el.querySelectorAll<HTMLElement>('[data-slot="resizable-panel"]');
    panels.forEach((panel) => {
      panel.style.transition = 'flex 300ms cubic-bezier(0.4, 0, 0.2, 1)';
    });
  }, []);

  const disablePanelTransition = useCallback(() => {
    const el = panelGroupRef.current;
    if (!el) return;
    const panels = el.querySelectorAll<HTMLElement>('[data-slot="resizable-panel"]');
    panels.forEach((panel) => {
      panel.style.transition = 'none';
    });
  }, []);

  // Keep the box current so a measurement landing at any moment has a real
  // layout to be a fraction of. Desktop only — the mobile branch returns a
  // drawer and never mounts this element, and nothing there has a split to
  // observe for.
  useEffect(() => {
    if (isMobile) {
      // Drop the box with the observer. A desktop box left behind would let a
      // measurement landing under the drawer compute a fit against a layout
      // that is no longer on screen — and run the 320ms resize timer for it.
      panelBoxRef.current = null;
      return;
    }
    const el = panelGroupRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      panelBoxRef.current = { width: box.width, height: box.height };
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [isMobile]);

  // Easy mode opens at the panel's MINIMUM width (35/65): the cards are a
  // narrow column and the chat is where the user lives — a 50/50 split steals
  // half the screen for whitespace. Advanced keeps 50/50 (its
  // stepper/terminal/browser views earn the room). A layer that needs more
  // room requests it through `panelSplit` — 70/30 for a presentation
  // deliverable (the deck needs real width), 50/50 for the terminal. A
  // document that reported its own shape beats all of that (`panelAspect`).
  // The drag handle still lets either mode go wider/narrower by hand.
  //
  // Memoized on exactly the states that may re-decide the width, so the box
  // read below is sampled at those moments and only those: this is what makes
  // the fit survive a window resize instead of chasing it.
  //
  // `panelBoxRef.current` is read here ON PURPOSE, outside the dep array —
  // this is a deliberate stale-ref read, not a missed dependency. Adding
  // `panelBox` to the deps (or promoting the ref to state so it re-renders)
  // would make every `ResizeObserver` tick re-decide `sideSize`, turning the
  // one-shot fit into a live window-resize follower: it would fight a
  // hand-dragged divider on every resize instead of leaving it alone, and a
  // window resize would re-run the 300ms glide `aspectChangedWidth` below is
  // built to fire only once per real change. Do not "fix" this lint.
  const sideSize = useMemo(
    () =>
      resolveSideSize({
        isExpanded,
        isEasy,
        panelAspect,
        panelSplit,
        panelBox: panelBoxRef.current,
      }),
    [isExpanded, isEasy, panelAspect, panelSplit],
  );
  const mainSize = 100 - sideSize;
  const prevSideSizeRef = useRef(sideSize);

  useEffect(() => {
    const expandChanged = prevExpandedRef.current !== isExpanded;
    const splitChanged = prevSplitRef.current !== panelSplit;
    // A fit measurement joins the SAME change detection, so it rides the same
    // 300ms glide — a ratio arriving during the entrance coalesces into it
    // rather than fighting it. Judged on the width it produces against the
    // panel's REAL width, which is why `getSize()` and not `prevSideSizeRef`:
    // a divider the user dragged moved the panel without telling us, so the
    // width we last commanded is not the width on screen. See
    // `aspectChangedWidth` for both failures this guards.
    const aspectChanged = aspectChangedWidth({
      prevAspect: prevAspectRef.current,
      nextAspect: panelAspect,
      currentSize: sidePanelRef.current?.getSize() ?? prevSideSizeRef.current,
      nextSize: sideSize,
    });
    prevExpandedRef.current = isExpanded;
    prevSplitRef.current = panelSplit;
    prevAspectRef.current = panelAspect;
    prevSideSizeRef.current = sideSize;

    // A detail-close collapse rides in with this flag set: snap the width, don't
    // glide it (the detail plays its own slide-out — a width animation under it
    // is a second, competing motion). Consume it here so the next deliberate
    // fullscreen/minimize toggle (or wide-open) animates as usual.
    const skipAnimation = useKortixComputerStore.getState().skipNextExpandAnimation;
    if (skipAnimation) useKortixComputerStore.setState({ skipNextExpandAnimation: false });

    const changed = expandChanged || splitChanged || aspectChanged;
    const shouldAnimate = changed && shouldShowPanel && !skipAnimation;

    if (shouldAnimate) {
      setIsAnimating(true);
    } else if (changed) {
      // Instant path: clear any transition left on the panels so the resize
      // below snaps rather than inheriting a prior glide.
      disablePanelTransition();
    }

    if (shouldShowPanel) {
      sidePanelRef.current?.resize(sideSize);
      mainPanelRef.current?.resize(mainSize);
    } else {
      sidePanelRef.current?.resize(0);
      mainPanelRef.current?.resize(100);
    }

    if (shouldAnimate) {
      const timer = setTimeout(() => {
        disablePanelTransition();
        setIsAnimating(false);
      }, 320);
      return () => clearTimeout(timer);
    }
  }, [
    shouldShowPanel,
    isExpanded,
    sessionId,
    disablePanelTransition,
    isEasy,
    panelSplit,
    panelAspect,
    sideSize,
    mainSize,
  ]);

  useEffect(() => {
    if (!isAnimating) return;
    const raf = requestAnimationFrame(() => {
      enablePanelTransition();
      sidePanelRef.current?.resize(sideSize);
      mainPanelRef.current?.resize(mainSize);
    });
    return () => cancelAnimationFrame(raf);
  }, [isAnimating, enablePanelTransition, sideSize, mainSize]);

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

  const [terminalActivated, setTerminalActivated] = useState(false);
  useEffect(() => {
    if (showTerminal) setTerminalActivated(true);
  }, [showTerminal]);

  const [browserActivated, setBrowserActivated] = useState(false);
  useEffect(() => {
    if (showBrowser) setBrowserActivated(true);
  }, [showBrowser]);

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

  // While booting, the panel is JUST the dead-center "Kortix Computer is
  // starting" loader — no header bar (the loader has its own heading, so a panel
  // title would be redundant), filling the whole card so it's perfectly
  // centered. The runtime-coupled views (Actions/Files/Terminal/Browser) need a
  // live sandbox, so they only render once booted.
  //
  // Easy mode has no header either: it is the three cards and nothing else. No
  // title, no view tabs, no mode button, no border. The mode is switched from
  // Settings → Appearance and the command palette. Nothing here is a dead end:
  // the detail card carries its own close button and Escape, which is the only
  // way this panel closes now — the header toggle is gone. ⌘I / Ctrl+I
  // toggles the action-panel column beside the chat, not this detail panel.
  const effectivePanelHeader = booting || isEasy ? null : panelHeader;
  const effectivePanelBody = booting ? (
    <SessionStartingLoader
      stage={bootStage ?? 'provisioning'}
      delayMs={0}
      projectId={projectId}
      sessionId={projectSessionId}
      variant="stepper"
    />
  ) : (
    panelBody
  );

  // The provider wraps BOTH panels. It has to: the floating overlay renders
  // inside `children` (the chat, in the main resizable panel) and every detail
  // renders in the side panel, and a card row clicked in one opens a detail in
  // the other. See `session-panel-provider.tsx`.
  const withPanelProvider = (node: React.ReactNode) => (
    <SessionPanelProvider
      sessionId={sessionId}
      messages={messages}
      isSessionBusy={isSessionBusy}
      projectId={projectId}
      projectSessionId={projectSessionId}
    >
      {node}
    </SessionPanelProvider>
  );

  if (isMobile) {
    return withPanelProvider(
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
      </div>,
    );
  }

  return withPanelProvider(
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
                'relative flex flex-col overflow-hidden bg-transparent transition-[padding] duration-300 ease-out',
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

            <ResizablePanel
              ref={sidePanelRef}
              defaultSize={shouldShowPanel ? (isEasy ? 35 : 50) : 0}
              minSize={shouldShowPanel ? (isAnimating ? 0 : isExpanded ? 100 : 35) : 0}
              maxSize={shouldShowPanel ? (isAnimating ? 100 : isExpanded ? 100 : 70) : 0}
              collapsible={!isExpanded || isAnimating}
              className={cn('bg-background relative overflow-hidden', !shouldShowPanel && 'hidden')}
            >
              <div
                className={cn('bg-background h-full transition-[padding] duration-300 ease-out')}
              >
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
          </ResizablePanelGroup>
        </div>
      </div>
    </SessionWallpaperLayerContext.Provider>,
  );
});

function PanelHeaderSwitcher({
  view,
  onChangeView,
  isSidePanelOpen,
  onTogglePanel,
  auditBadge = 0,
  onToggleMode,
}: {
  view: SessionPanelView;
  onChangeView: (next: SessionPanelView) => void;
  isSidePanelOpen: boolean;
  onTogglePanel: () => void;
  /** Pending-approval count shown on the "Audit" tab; 0 hides the badge. */
  auditBadge?: number;
  /** Flips `preferences.panelMode` back to 'easy'. Advanced-only — Easy mode
   *  renders no header at all, so it has no button to switch with. */
  onToggleMode: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');

  const panelToggle = (
    <Hint
      side="bottom"
      sideOffset={4}
      delayDuration={300}
      // No ⌘I hint here: that shortcut toggles the action-panel column, not
      // this Advanced-mode detail toggle.
      label={<span className="flex items-center gap-1.5">{isSidePanelOpen ? 'Close' : 'Open'} panel</span>}
    >
      <Button
        variant="ghost"
        size="icon"
        onClick={onTogglePanel}
        className={cn(
          'h-7 cursor-pointer transition-colors',
          isSidePanelOpen ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <PanelRight className="h-4 w-4" mirrored />
      </Button>
    </Hint>
  );

  return (
    <div className="flex shrink-0 items-center justify-between border-b p-2">
      <Tabs
        value={view}
        onValueChange={(next) => onChangeView(next as SessionPanelView)}
        className="gap-0 p-0"
      >
        <TabsList
          animate="none"
          size="sm"
          className="h-7 border-b-0 p-0"
          aria-label={tHardcodedUi.raw(
            'componentsSessionSessionLayout.line348JsxAttrAriaLabelSidePanelView',
          )}
        >
          <TabsTrigger size="xs" value="actions" className="h-7 w-fit">
            Actions
          </TabsTrigger>
          <TabsTrigger size="xs" value="browser" className="h-7 w-fit">
            Browser
          </TabsTrigger>
          <TabsTrigger size="xs" value="explorer" className="h-7 w-fit">
            Files
          </TabsTrigger>
          <TabsTrigger size="xs" value="terminal" className="h-7 w-fit">
            Terminal
          </TabsTrigger>
          <TabsTrigger size="xs" value="audit" className="h-7 w-fit">
            Audit
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleMode}
          className="text-muted-foreground hover:text-foreground h-7 cursor-pointer text-xs"
        >
          Easy
        </Button>
        {panelToggle}
      </div>
    </div>
  );
}
