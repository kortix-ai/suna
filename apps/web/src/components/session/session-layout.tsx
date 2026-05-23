'use client';

import { useTranslations } from 'next-intl';
import React, { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react';
import * as ResizablePrimitive from 'react-resizable-panels';
import { PreviewTabContent } from '@/components/tabs/preview-tab-content';
import { useIsMobile } from '@/hooks/utils';
import { cn } from '@/lib/utils';
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  useKortixComputerStore,
} from '@/stores/kortix-computer-store';
import { useOpenCodeMessages } from '@/hooks/opencode/use-opencode-sessions';
import { useTabStore } from '@/stores/tab-store';
import {
  sessionPreviewTabId,
  useSessionBrowserStore,
  type SessionPanelView,
} from '@/stores/session-browser-store';
import { SessionFilesPanel } from '@/components/session/session-files-panel';
import {
  SessionActionsPanel,
  collectToolParts,
} from '@/components/session/session-actions-panel';
import { Drawer, DrawerContent } from '@/components/ui/drawer';
import { X } from 'lucide-react';

// ============================================================================
// Session Layout
// ============================================================================

interface SessionLayoutProps {
  sessionId: string;
  children: React.ReactNode;
}

export const SessionLayout = memo(function SessionLayout({
  sessionId,
  children,
}: SessionLayoutProps) {
  const isMobile = useIsMobile();

  const { data: messages } = useOpenCodeMessages(sessionId);

  // Use individual selectors to avoid re-rendering on unrelated store changes
  // (e.g. currentSandboxId, files store resets). Destructuring the whole store
  // subscribes to ALL properties and causes unnecessary re-renders for every
  // open session tab.
  const isSidePanelOpen = useKortixComputerStore((s) => s.isSidePanelOpen);
  const setIsSidePanelOpen = useKortixComputerStore((s) => s.setIsSidePanelOpen);
  const setActiveSession = useKortixComputerStore((s) => s.setActiveSession);
  const shouldOpenPanel = useKortixComputerStore((s) => s.shouldOpenPanel);
  const clearShouldOpenPanel = useKortixComputerStore((s) => s.clearShouldOpenPanel);
  const isExpanded = useKortixComputerStore((s) => s.isExpanded);
  const toggleExpanded = useKortixComputerStore((s) => s.toggleExpanded);

  // Track active tab to restore per-session panel state on tab switch
  const activeTabId = useTabStore((s) => s.activeTabId);
  const isActiveTab = activeTabId === sessionId;

  useEffect(() => {
    if (isActiveTab) {
      setActiveSession(sessionId);
    }
  }, [isActiveTab, sessionId, setActiveSession]);

  const hasToolCalls = useMemo(
    () => collectToolParts(messages).length > 0,
    [messages],
  );

  // Right-side panel view — actions (tool calls) or internal browser.
  // Per-session, so each session remembers which view the user prefers.
  const panelView = useSessionBrowserStore((s) => s.viewBySession[sessionId] ?? 'actions');
  const setPanelView = useSessionBrowserStore((s) => s.setView);
  const showBrowser = panelView === 'browser';
  const showFiles = panelView === 'files';

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

  // Side panel is visible when the user has explicitly opened it AND there's
  // something to show. The "something to show" rule used to be just "we have
  // tool calls"; with the browser view it also includes "browser is the
  // active view" — so the user can pop the panel open just to use the
  // internal browser even before the agent has run any tools.
  const shouldShowPanel =
    isSidePanelOpen && (hasToolCalls || showBrowser || showFiles);

  // ⌘I / Ctrl+I toggles the side panel open/closed.
  //
  // In the dashboard every session tab is pre-mounted (hidden via CSS), so we
  // must only respond on the active tab. But the standalone session route
  // mounts a single SessionLayout whose id isn't in the tab system at all —
  // there `isActiveTab` is always false, so gate on it only when this session
  // actually is a tab.
  const isInTabSystem = useTabStore((s) => !!s.tabs[sessionId]);
  const shouldHandleHotkey = isInTabSystem ? isActiveTab : true;
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
    />
  );

  // The active side-panel body. "Actions" renders through the canonical
  // ToolPartRenderer (via SessionActionsPanel) — the same handlers the chat
  // uses — so there is exactly one tool-rendering implementation.
  const panelBody = showBrowser ? (
    <PreviewTabContent tabId={sessionPreviewTabId(sessionId)} />
  ) : showFiles ? (
    <SessionFilesPanel />
  ) : (
    <SessionActionsPanel sessionId={sessionId} messages={messages} />
  );

  // Mobile
  if (isMobile) {
    return (
      <div className="flex flex-col h-full w-full overflow-hidden">
        <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
          {children}
        </div>
        <Drawer
          open={shouldShowPanel}
          onOpenChange={(open) => {
            if (!open) handleSidePanelClose();
          }}
        >
          <DrawerContent className="flex h-[85dvh] max-h-[85dvh] flex-col overflow-hidden p-0">
            {panelHeader}
            <div className="min-h-0 flex-1 overflow-hidden">{panelBody}</div>
          </DrawerContent>
        </Drawer>
      </div>
    );
  }

  // Desktop: resizable split panel
  return (
    <div className="flex flex-col h-full overflow-hidden bg-background" data-testid="session-layout">
      <div ref={panelGroupRef} className="flex-1 min-h-0 flex overflow-hidden bg-background">
        <ResizablePanelGroup
          direction="horizontal"
          className="h-full bg-background"
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
              "flex flex-col overflow-hidden relative bg-transparent transition-[padding] duration-300 ease-out",
              shouldShowPanel && "pl-3 pr-1.5",
              isExpanded && !isAnimating && "opacity-0 pointer-events-none"
            )}
          >
            <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
              {children}
            </div>
          </ResizablePanel>

          {/* Resizable handle */}
          <ResizableHandle
            withHandle={shouldShowPanel && !isExpanded}
            disabled={!shouldShowPanel || isExpanded}
            className={cn(
              'z-20 transition-opacity duration-300',
              shouldShowPanel && !isExpanded ? 'w-0 opacity-100' : 'w-0 opacity-0 pointer-events-none'
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
            className={cn(
              'relative overflow-hidden bg-background',
              !shouldShowPanel && 'hidden',
            )}
          >
            <div className={cn(
              "h-full transition-[padding] duration-300 ease-out bg-background",
              isExpanded ? "p-0" : "pt-3 pb-6 pr-3 sm:pr-4 pl-1.5"
            )}>
              <SidePanelFrame header={panelHeader}>{panelBody}</SidePanelFrame>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
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
}: {
  view: SessionPanelView;
  onChangeView: (next: SessionPanelView) => void;
  onClose: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="flex-shrink-0 flex items-center justify-between h-10 pl-4 pr-2 border-b border-border/40">
      {/* Plain text tabs with an underline on active — no chip, no fill. */}
      <div role="tablist" aria-label={tHardcodedUi.raw('componentsSessionSessionLayout.line348JsxAttrAriaLabelSidePanelView')} className="flex items-center gap-5">
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
          active={view === 'files'}
          onClick={() => onChangeView('files')}
          label="Changes"
        />
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onClose}
            className="inline-flex items-center justify-center h-7 w-7 rounded-full text-muted-foreground/70 hover:text-foreground hover:bg-foreground/[0.04] transition-colors cursor-pointer"
            aria-label={tHardcodedUi.raw('componentsSessionSessionLayout.line370JsxAttrAriaLabelClosePanel')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          {tHardcodedUi.raw('componentsSessionSessionLayout.line376JsxTextClosePanel')}<kbd className="ml-1.5 rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
            {tHardcodedUi.raw('componentsSessionSessionLayout.line378JsxTextI')}</kbd>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

function PanelTabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'relative inline-flex items-center h-10 text-xs tracking-tight transition-colors cursor-pointer',
        active
          ? 'text-foreground font-medium'
          : 'text-muted-foreground/70 hover:text-foreground/90',
      )}
    >
      {label}
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
    <div className="h-full w-full flex flex-col bg-card overflow-hidden min-w-0 min-h-0 border rounded-2xl">
      {header}
      <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
