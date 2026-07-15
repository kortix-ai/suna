'use client';

import { Button } from '@/components/ui/button';
import { Drawer, DrawerContent } from '@/components/ui/drawer';
import Hint from '@/components/ui/hint';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ActionPanel } from '@/features/session/action-panel';
import { BrowserPanel } from '@/features/session/action-panel/browser-panel';
import { useDeliverableReadiness } from '@/features/session/action-panel/shared/use-deliverable-readiness';
import { SessionAuditPanel } from '@/features/session/session-audit-panel';
import { isPendingAction, useSessionAudit } from '@/features/session/session-audit-shared';
import { SessionFilesExplorer } from '@/features/session/session-files-explorer';
import { SessionStartingLoader } from '@/features/session/session-starting-loader';
import { SessionTerminalPanel } from '@/features/session/session-terminal-panel';
import { SessionWallpaperLayerContext } from '@/features/session/session-wallpaper-layer';
import { useOpenCodeMessages } from '@/hooks/opencode/use-opencode-sessions';
import { useIsMobile } from '@/hooks/utils';
import { cn } from '@/lib/utils';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import {
  SessionPanelView,
  sessionPreviewTabId,
  useSessionBrowserStore,
} from '@/stores/session-browser-store';
import { useSyncStore } from '@/stores/opencode-sync-store';
import { useTabStore } from '@/stores/tab-store';
import { useUserPreferencesStore } from '@/stores/user-preferences-store';
import type { SessionStartStage } from '@kortix/sdk/projects-client';
import { PanelRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type React from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
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

  const { data: messages } = useOpenCodeMessages(sessionId);

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

  const storedPanelView = useSessionBrowserStore((s) => s.viewBySession[sessionId] ?? 'actions');
  const panelView: SessionPanelView = storedPanelView === 'files' ? 'explorer' : storedPanelView;
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
  const sessionStatus = useSyncStore((s) => s.sessionStatus[sessionId]);
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

  const mainPanelRef = useRef<ResizablePrimitive.ImperativePanelHandle>(null);
  const sidePanelRef = useRef<ResizablePrimitive.ImperativePanelHandle>(null);
  const panelGroupRef = useRef<HTMLDivElement>(null);
  const prevExpandedRef = useRef(isExpanded);

  const [wallpaperLayer, setWallpaperLayer] = useState<HTMLDivElement | null>(null);

  const shouldShowPanel = isSidePanelOpen;

  const isInTabSystem = useTabStore((s) => !!s.tabs[sessionId]);
  const shouldHandleHotkey = isInTabSystem ? isActiveTab : true;

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
  useEffect(() => {
    if (!shouldHandleHotkey) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault();
        if (isSidePanelOpen) handleSidePanelClose();
        else setIsSidePanelOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shouldHandleHotkey, isSidePanelOpen, handleSidePanelClose, setIsSidePanelOpen]);

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

  useEffect(() => {
    const expandChanged = prevExpandedRef.current !== isExpanded;
    prevExpandedRef.current = isExpanded;

    // A detail-close collapse rides in with this flag set: snap the width, don't
    // glide it (the detail plays its own slide-out — a width animation under it
    // is a second, competing motion). Consume it here so the next deliberate
    // fullscreen/minimize toggle animates as usual.
    const skipAnimation = useKortixComputerStore.getState().skipNextExpandAnimation;
    if (skipAnimation) useKortixComputerStore.setState({ skipNextExpandAnimation: false });

    const shouldAnimate = expandChanged && shouldShowPanel && !skipAnimation;

    if (shouldAnimate) {
      setIsAnimating(true);
    } else if (expandChanged) {
      // Instant path: clear any transition left on the panels so the resize
      // below snaps rather than inheriting a prior glide.
      disablePanelTransition();
    }

    if (shouldShowPanel) {
      if (isExpanded) {
        sidePanelRef.current?.resize(100);
        mainPanelRef.current?.resize(0);
      } else {
        sidePanelRef.current?.resize(50);
        mainPanelRef.current?.resize(50);
      }
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
  }, [shouldShowPanel, isExpanded, sessionId, disablePanelTransition]);

  useEffect(() => {
    if (!isAnimating) return;
    const raf = requestAnimationFrame(() => {
      enablePanelTransition();
      if (isExpanded) {
        sidePanelRef.current?.resize(100);
        mainPanelRef.current?.resize(0);
      } else {
        sidePanelRef.current?.resize(50);
        mainPanelRef.current?.resize(50);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [isAnimating, enablePanelTransition, isExpanded]);

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

  const swappableBody = showAudit ? (
    <SessionAuditPanel projectId={projectId} projectSessionId={projectSessionId} />
  ) : showExplorer ? (
    <SessionFilesExplorer
      chatSessionId={sessionId}
      projectId={projectId}
      projectSessionId={projectSessionId}
    />
  ) : (
    <ActionPanel sessionId={sessionId} messages={messages} isSessionBusy={isSessionBusy} />
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
  // Settings → Appearance and the command palette; the chat header's own panel
  // toggle still closes the panel (as does ⌘I), so nothing here is a dead end.
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

  if (isMobile) {
    return (
      <div className="flex h-full w-full flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
        <Drawer
          open={shouldShowPanel}
          onOpenChange={(open) => {
            if (!open) handleSidePanelClose();
          }}
        >
          <DrawerContent className="flex h-[85dvh] max-h-[85dvh] flex-col overflow-hidden p-0">
            {effectivePanelHeader}
            <div className="min-h-0 flex-1 overflow-hidden">{effectivePanelBody}</div>
          </DrawerContent>
        </Drawer>
      </div>
    );
  }

  return (
    <SessionWallpaperLayerContext.Provider value={wallpaperLayer}>
      <div
        className="bg-background relative flex h-full flex-col overflow-hidden"
        data-testid="session-layout"
      >
        <div
          ref={panelGroupRef}
          className={cn(
            'relative flex min-h-0 flex-1 overflow-hidden',
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
            className="h-full bg-transparent"
            style={{ transition: 'none' }}
          >
            <ResizablePanel
              ref={mainPanelRef}
              defaultSize={shouldShowPanel ? 50 : 100}
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

            <ResizableHandle
              withHandle={shouldShowPanel && !isExpanded}
              disabled={!shouldShowPanel || isExpanded}
              className={cn(
                'z-20 transition-opacity duration-300',
                shouldShowPanel && !isExpanded
                  ? 'w-0 opacity-100'
                  : 'pointer-events-none w-0 opacity-0',
              )}
            />

            <ResizablePanel
              ref={sidePanelRef}
              defaultSize={shouldShowPanel ? 50 : 0}
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
                    'border-border flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden',
                    // Easy mode is chrome-free — the cards carry their own
                    // borders, so a panel border would just box a box.
                    !isEasy && 'border-l',
                  )}
                >
                  {effectivePanelHeader}
                  <div className="min-h-0 flex-1 overflow-hidden">{effectivePanelBody}</div>
                </div>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </div>
    </SessionWallpaperLayerContext.Provider>
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
      label={
        <span className="flex items-center gap-1.5">
          {isSidePanelOpen ? 'Close' : 'Open'} panel
          <KbdGroup>
            <Kbd className="font-mono">
              {tHardcodedUi.raw('componentsSessionSessionSiteHeader.line185JsxTextI')}
            </Kbd>
          </KbdGroup>
        </span>
      }
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
        <PanelRight className="h-4 w-4" />
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
          type="secondary"
          animate="none"
          size="sm"
          className="h-7 border-b-0 p-0"
          aria-label={tHardcodedUi.raw(
            'componentsSessionSessionLayout.line348JsxAttrAriaLabelSidePanelView',
          )}
        >
          <TabsTrigger size="xs" value="actions" variant="secondary" className="h-7 w-fit">
            Actions
          </TabsTrigger>
          <TabsTrigger size="xs" value="browser" variant="secondary" className="h-7 w-fit">
            Browser
          </TabsTrigger>
          <TabsTrigger size="xs" value="explorer" variant="secondary" className="h-7 w-fit">
            Files
          </TabsTrigger>
          <TabsTrigger size="xs" value="terminal" variant="secondary" className="h-7 w-fit">
            Terminal
          </TabsTrigger>
          <TabsTrigger size="xs" value="audit" variant="secondary" className="h-7 w-fit">
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
