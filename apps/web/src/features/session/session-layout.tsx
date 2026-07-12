'use client';

import { PreviewTabContent } from '@/components/tabs/preview-tab-content';
import { Drawer, DrawerContent } from '@/components/ui/drawer';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SessionActionsPanel } from '@/features/session/session-actions-panel';
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
  type SessionPanelView,
  sessionPreviewTabId,
  useSessionBrowserStore,
} from '@/stores/session-browser-store';
import { useTabStore } from '@/stores/tab-store';
import type { SessionStartStage } from '@kortix/sdk/projects-client';
import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type React from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type * as ResizablePrimitive from 'react-resizable-panels';

// ============================================================================
// Session Layout
// ============================================================================

interface SessionLayoutProps {
  sessionId: string;
  projectId?: string;
  projectSessionId?: string;
  children: React.ReactNode;
  /**
   * When set, the side-panel CONTENT is the centered "Kortix Computer is
   * starting" loader instead of the runtime-coupled Actions/Files/Terminal/
   * Browser views (which need a live sandbox). The instant shell clears this once
   * the runtime is ready, so the panel falls back to the real (empty) Actions
   * view. Panel VISIBILITY stays user-controlled — this never force-opens it.
   */
  bootStage?: SessionStartStage | null;
  /**
   * Marks this as the transient instant-session shell: its per-session
   * active-registration effects are skipped so it never fights the real
   * SessionLayout that crossfades in over it.
   */
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

  // Track active tab to restore per-session panel state on tab switch
  // Subscribe to the BOOLEAN (am-I-active) rather than the raw activeTabId so a
  // tab switch only re-renders the two panes whose active state flips — not
  // every pre-mounted session layout. Keeps switching 0-latency.
  const isActiveTab = useTabStore((s) => s.activeTabId === sessionId);

  useEffect(() => {
    if (transient) return; // transient shell — don't claim the active session
    if (isActiveTab) {
      setActiveSession(sessionId);
    }
  }, [transient, isActiveTab, sessionId, setActiveSession]);

  // Right-side panel view — actions (tool calls) or internal browser.
  // Per-session, so each session remembers which view the user prefers.
  const storedPanelView = useSessionBrowserStore((s) => s.viewBySession[sessionId] ?? 'actions');
  // The standalone "Changes" view ('files') is folded into the Files explorer
  // (its version banner shows the diff + change-request action), so coerce any
  // persisted 'files' selection to 'explorer'.
  const panelView: SessionPanelView = storedPanelView === 'files' ? 'explorer' : storedPanelView;
  const setPanelView = useSessionBrowserStore((s) => s.setView);
  const setActivePanelSession = useSessionBrowserStore((s) => s.setActiveSessionId);
  const showBrowser = panelView === 'browser';
  const showExplorer = panelView === 'explorer';
  const showTerminal = panelView === 'terminal';
  const showAudit = panelView === 'audit';

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

  // Root-level full-bleed wallpaper layer. SessionChat portals its welcome
  // wallpaper into this node so it spans the ENTIRE session width regardless of
  // the resizable split (see session-wallpaper-layer.tsx). A state node (not a
  // ref) so SessionChat re-renders the portal once the layer mounts.
  const [wallpaperLayer, setWallpaperLayer] = useState<HTMLDivElement | null>(null);

  // Side panel is visible whenever the user has opened it — full stop. Opening
  // is gated purely on the user's intent (the instant shell auto-opens it once a
  // task is kicked off). While booting, its CONTENT is the "Kortix Computer is
  // starting" loader instead of Actions — so opening it any time before the
  // computer is ready shows boot status, switching to Actions once booted.
  const shouldShowPanel = isSidePanelOpen;

  // ⌘I / Ctrl+I toggles the side panel open/closed.
  //
  // In the dashboard every session tab is pre-mounted (hidden via CSS), so we
  // must only respond on the active tab. But the standalone session route
  // mounts a single SessionLayout whose id isn't in the tab system at all —
  // there `isActiveTab` is always false, so gate on it only when this session
  // actually is a tab.
  const isInTabSystem = useTabStore((s) => !!s.tabs[sessionId]);
  const shouldHandleHotkey = isInTabSystem ? isActiveTab : true;

  // Publish this layout's panel key (the OpenCode chatSessionId) as the active
  // session whenever it's the visible one, so chat click handlers (file paths,
  // localhost links) route into THIS panel rather than guessing from the URL —
  // the URL carries the Kortix session id, which differs from this key. Only
  // the active tab (or the sole standalone layout) registers; clear on unmount
  // if we still own the slot.
  const isVisibleLayout = isInTabSystem ? isActiveTab : true;
  useEffect(() => {
    if (transient) return; // transient shell — the real layout owns panel routing
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

  // Track whether we're mid-animation so we can use relaxed constraints
  // that allow intermediate sizes (e.g. 75%) during the transition.
  const [isAnimating, setIsAnimating] = useState(false);

  // Enable smooth CSS transition on panel flex properties during expand/collapse.
  // react-resizable-panels uses flex-basis internally; adding a transition on
  // the flex shorthand makes the imperative resize() calls animate smoothly.
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

  // Imperatively resize panels when visibility, expand state, or session changes.
  // Including sessionId ensures panels are correctly sized after navigating
  // between sessions (e.g. fork → parent), since the ResizablePanelGroup may
  // retain stale sizes from the previous session's layout.
  useEffect(() => {
    const expandChanged = prevExpandedRef.current !== isExpanded;
    prevExpandedRef.current = isExpanded;

    // Only animate when the expand state toggles (not on initial mount or
    // session switch). Panel open/close has its own flow.
    const shouldAnimate = expandChanged && shouldShowPanel;

    if (shouldAnimate) {
      // Relax constraints first so intermediate sizes are allowed,
      // then enable CSS transition and trigger the resize.
      setIsAnimating(true);
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

  // Enable the CSS transition once isAnimating flips to true and the relaxed
  // constraints have been applied to the DOM (i.e. after React re-renders).
  // We use a layout-effect–like pattern with requestAnimationFrame to ensure
  // the browser has committed the constraint update before we add the
  // transition and trigger the resize.
  useEffect(() => {
    if (!isAnimating) return;
    // Wait one frame so the relaxed min/max sizes are painted,
    // then enable the transition and imperatively trigger the resize.
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

  // Side-panel header switcher (Actions / Browser / Files) — shared by the
  // mobile drawer and the desktop split panel.
  const panelHeader = (
    <PanelHeaderSwitcher
      view={panelView}
      onChangeView={(v) => setPanelView(sessionId, v)}
      onClose={handleSidePanelClose}
      auditBadge={auditPendingCount}
    />
  );

  // The terminal is a long-lived shell: once opened it stays MOUNTED (just
  // hidden) when the user switches tabs or closes the panel, so its WebSocket
  // never tears down and reconnects. Reconnecting would replay the scrollback
  // and re-run setup — i.e. the terminal would appear to "reset" on every open.
  const [terminalActivated, setTerminalActivated] = useState(false);
  useEffect(() => {
    if (showTerminal) setTerminalActivated(true);
  }, [showTerminal]);

  // The browser preview is the same story: its iframe holds a live, loaded
  // sandbox app (scroll position, client-side route, form/auth state). Swapping
  // it out of the tree on every view switch re-mounts the iframe and reloads
  // the page — a white flash and lost state each time. So once opened it stays
  // MOUNTED and is toggled with `hidden` (display:none), exactly like the
  // terminal; the iframe keeps its document alive in the background.
  const [browserActivated, setBrowserActivated] = useState(false);
  useEffect(() => {
    if (showBrowser) setBrowserActivated(true);
  }, [showBrowser]);

  // The cheap, stateless views — "Actions" (the canonical ToolPartRenderer, the
  // same handlers the chat uses) and the Files explorer — swap normally. The
  // terminal and browser are layered on top and shown/hidden via `hidden`
  // rather than unmounted, so their live state survives view switches.
  const swappableBody = showAudit ? (
    <SessionAuditPanel projectId={projectId} projectSessionId={projectSessionId} />
  ) : showExplorer ? (
    <SessionFilesExplorer
      chatSessionId={sessionId}
      projectId={projectId}
      projectSessionId={projectSessionId}
    />
  ) : (
    <SessionActionsPanel sessionId={sessionId} messages={messages} />
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
          <PreviewTabContent
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
  const effectivePanelHeader = booting ? null : panelHeader;
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

  // Mobile
  if (isMobile) {
    return (
      <div className="flex flex-col h-full w-full overflow-hidden">
        <div className="flex-1 overflow-hidden min-h-0 flex flex-col">{children}</div>
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

  // Desktop: resizable split panel
  return (
    <SessionWallpaperLayerContext.Provider value={wallpaperLayer}>
      <div
        className="relative flex flex-col h-full overflow-hidden bg-background"
        data-testid="session-layout"
      >
        {/* Full-bleed wallpaper layer — spans the ENTIRE session width, behind the
          resizable split. SessionChat portals its welcome wallpaper in here so
          the wallpaper always renders full-width and never shrinks/recrops when
          the side panel opens. The transparent main panel reveals it; the opaque
          side panel covers its own half. */}
        {/* <div
        ref={setWallpaperLayer}
        className="absolute inset-0 z-0 pointer-events-none overflow-hidden"
        aria-hidden="true"
      /> */}
        <div ref={panelGroupRef} className="relative z-10 flex-1 min-h-0 flex overflow-hidden">
          <ResizablePanelGroup
            direction="horizontal"
            className="h-full bg-transparent"
            style={{ transition: 'none' }}
          >
            {/* Main content panel (SessionChat) */}
            <ResizablePanel
              ref={mainPanelRef}
              defaultSize={shouldShowPanel ? 50 : 100}
              minSize={shouldShowPanel ? (isAnimating ? 0 : isExpanded ? 0 : 30) : 100}
              maxSize={shouldShowPanel ? (isAnimating ? 100 : isExpanded ? 0 : 65) : 100}
              collapsible={isExpanded || isAnimating}
              className={cn(
                'flex flex-col overflow-hidden relative bg-transparent transition-[padding] duration-300 ease-out',
                shouldShowPanel && 'pl-3 pr-1.5',
                isExpanded && !isAnimating && 'opacity-0 pointer-events-none',
              )}
            >
              <div className="flex-1 overflow-hidden min-h-0 flex flex-col">{children}</div>
            </ResizablePanel>

            {/* Resizable handle */}
            <ResizableHandle
              withHandle={shouldShowPanel && !isExpanded}
              disabled={!shouldShowPanel || isExpanded}
              className={cn(
                'z-20 transition-opacity duration-300',
                shouldShowPanel && !isExpanded
                  ? 'w-0 opacity-100'
                  : 'w-0 opacity-0 pointer-events-none',
              )}
            />

            {/* Side panel — Actions (tool calls) / Browser / Files.
              The user toggles between them via the header switcher. */}
            <ResizablePanel
              ref={sidePanelRef}
              defaultSize={shouldShowPanel ? 50 : 0}
              minSize={shouldShowPanel ? (isAnimating ? 0 : isExpanded ? 100 : 35) : 0}
              maxSize={shouldShowPanel ? (isAnimating ? 100 : isExpanded ? 100 : 70) : 0}
              collapsible={!isExpanded || isAnimating}
              className={cn('relative overflow-hidden bg-background', !shouldShowPanel && 'hidden')}
            >
              <div
                className={cn(
                  'h-full transition-[padding] duration-300 ease-out bg-background',
                  isExpanded ? 'p-0' : 'pt-3 pb-6 pr-3 sm:pr-4 pl-1.5',
                )}
              >
                <SidePanelFrame header={effectivePanelHeader}>{effectivePanelBody}</SidePanelFrame>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </div>
    </SessionWallpaperLayerContext.Provider>
  );
});

// ============================================================================
// Side-panel header switcher
// ============================================================================
//
// Sits where the old "Actions" label + close button used to be. Adds a
// two-icon toggle: Actions | Browser. Clicking flips `panelView` in the
// session-browser store, which the parent uses to swap the body content.
function PanelHeaderSwitcher({
  view,
  onChangeView,
  onClose,
  auditBadge = 0,
}: {
  view: SessionPanelView;
  onChangeView: (next: SessionPanelView) => void;
  onClose: () => void;
  /** Pending-approval count shown on the "Audit" tab; 0 hides the badge. */
  auditBadge?: number;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="flex-shrink-0 flex items-center justify-between h-10 pl-4 pr-2 border-b border-border/60">
      {/* Plain text tabs with an underline on active — no chip, no fill. */}
      <div
        role="tablist"
        aria-label={tHardcodedUi.raw(
          'componentsSessionSessionLayout.line348JsxAttrAriaLabelSidePanelView',
        )}
        className="flex min-w-0 items-center gap-5 overflow-x-auto"
      >
        <PanelTabButton
          active={view === 'actions'}
          onClick={() => onChangeView('actions')}
          label="Actions"
        />
        <PanelTabButton
          active={view === 'browser'}
          onClick={() => onChangeView('browser')}
          label="Browser"
        />
        <PanelTabButton
          active={view === 'explorer'}
          onClick={() => onChangeView('explorer')}
          label="Files"
        />
        <PanelTabButton
          active={view === 'terminal'}
          onClick={() => onChangeView('terminal')}
          label="Terminal"
        />
        <PanelTabButton
          active={view === 'audit'}
          onClick={() => onChangeView('audit')}
          label="Audit"
          badgeCount={auditBadge}
        />
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onClose}
            className="inline-flex items-center justify-center h-7 w-7 rounded-full text-muted-foreground/70 hover:text-foreground hover:bg-foreground/[0.04] transition-colors cursor-pointer"
            aria-label={tHardcodedUi.raw(
              'componentsSessionSessionLayout.line370JsxAttrAriaLabelClosePanel',
            )}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          {tHardcodedUi.raw('componentsSessionSessionLayout.line376JsxTextClosePanel')}
          <kbd className="ml-1.5 rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
            {tHardcodedUi.raw('componentsSessionSessionLayout.line378JsxTextI')}
          </kbd>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

function PanelTabButton({
  active,
  onClick,
  label,
  badgeCount = 0,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  /** When > 0, an amber count pill trails the label (e.g. pending approvals). */
  badgeCount?: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'relative inline-flex items-center gap-1.5 h-10 shrink-0 whitespace-nowrap text-xs tracking-tight transition-colors cursor-pointer',
        active
          ? 'text-foreground font-medium'
          : 'text-muted-foreground/70 hover:text-foreground/90',
      )}
    >
      {label}
      {badgeCount > 0 && (
        <span
          aria-label={`${badgeCount} pending`}
          className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-600 px-1 text-[10px] font-semibold leading-none text-white"
        >
          {badgeCount}
        </span>
      )}
      {active && (
        <span aria-hidden className="absolute -bottom-px left-0 right-0 h-px bg-foreground" />
      )}
    </button>
  );
}

// Shared frame for every side-panel view (Actions / Browser / Files):
// a bordered card with the header switcher on top and the view body below.
function SidePanelFrame({
  header,
  children,
}: {
  header: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="h-full w-full flex flex-col bg-card overflow-hidden min-w-0 min-h-0 border border-border rounded-[24px]">
      {header}
      <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
